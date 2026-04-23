"""Socket server that runs inside Blender (headless).

Launched by the Node bridge with:
    blender --background --python server.py

Accepts newline-delimited JSON requests on 127.0.0.1:$BLENDER_MCP_PORT and
dispatches them to action handlers that wrap `bpy`. One pending request at a
time; the accept loop re-runs after a client disconnects so Blender survives
MCP server restarts.
"""
from __future__ import annotations

import contextlib
import io
import json
import math
import os
import socket
import sys
import traceback

import bpy  # type: ignore


PORT = int(os.environ.get("BLENDER_MCP_PORT", "54321"))
HOST = "127.0.0.1"


def _scene():
    scene = bpy.context.scene
    return {
        "scene": scene.name,
        "frame": scene.frame_current,
        "frame_start": scene.frame_start,
        "frame_end": scene.frame_end,
        "engine": scene.render.engine,
        "resolution": [scene.render.resolution_x, scene.render.resolution_y],
        "objects": [
            {
                "name": o.name,
                "type": o.type,
                "location": list(o.location),
                "rotation_euler": list(o.rotation_euler),
                "scale": list(o.scale),
                "dimensions": list(o.dimensions),
                "parent": o.parent.name if o.parent else None,
                "hidden": not o.visible_get(),
                "data": o.data.name if o.data else None,
                "materials": [s.material.name for s in o.material_slots if s.material],
            }
            for o in bpy.data.objects
        ],
        "cameras": [c.name for c in bpy.data.cameras],
        "lights": [l.name for l in bpy.data.lights],
        "materials": [m.name for m in bpy.data.materials],
        "meshes": [m.name for m in bpy.data.meshes],
        "collections": [c.name for c in bpy.data.collections],
        "filepath": bpy.data.filepath,
    }


def _create(primitive: str, name=None, location=None, scale=None):
    ops = {
        "cube": bpy.ops.mesh.primitive_cube_add,
        "sphere": bpy.ops.mesh.primitive_uv_sphere_add,
        "ico_sphere": bpy.ops.mesh.primitive_ico_sphere_add,
        "plane": bpy.ops.mesh.primitive_plane_add,
        "cone": bpy.ops.mesh.primitive_cone_add,
        "cylinder": bpy.ops.mesh.primitive_cylinder_add,
        "torus": bpy.ops.mesh.primitive_torus_add,
        "monkey": bpy.ops.mesh.primitive_monkey_add,
        "camera": bpy.ops.object.camera_add,
        "light_point": lambda **kw: bpy.ops.object.light_add(type="POINT", **kw),
        "light_sun": lambda **kw: bpy.ops.object.light_add(type="SUN", **kw),
        "light_spot": lambda **kw: bpy.ops.object.light_add(type="SPOT", **kw),
        "light_area": lambda **kw: bpy.ops.object.light_add(type="AREA", **kw),
        "empty": lambda **kw: bpy.ops.object.empty_add(type="PLAIN_AXES", **kw),
    }
    if primitive not in ops:
        raise ValueError(f"unknown primitive: {primitive}")
    kw = {}
    if location is not None:
        kw["location"] = tuple(location)
    ops[primitive](**kw)
    obj = bpy.context.active_object
    if name:
        obj.name = name
    if scale is not None:
        obj.scale = tuple(scale)
    return {"name": obj.name, "type": obj.type}


def _delete(name: str):
    obj = bpy.data.objects.get(name)
    if obj is None:
        raise ValueError(f"object not found: {name}")
    bpy.data.objects.remove(obj, do_unlink=True)
    return {"deleted": name}


def _transform(name: str, location=None, rotation_euler=None, scale=None):
    obj = bpy.data.objects.get(name)
    if obj is None:
        raise ValueError(f"object not found: {name}")
    if location is not None:
        obj.location = tuple(location)
    if rotation_euler is not None:
        obj.rotation_euler = tuple(rotation_euler)
    if scale is not None:
        obj.scale = tuple(scale)
    return {
        "name": name,
        "location": list(obj.location),
        "rotation_euler": list(obj.rotation_euler),
        "scale": list(obj.scale),
    }


def _render(output_path: str, resolution_x=None, resolution_y=None,
            samples=None, engine=None, camera=None, frame=None):
    scene = bpy.context.scene
    if engine:
        scene.render.engine = engine
    if resolution_x:
        scene.render.resolution_x = int(resolution_x)
    if resolution_y:
        scene.render.resolution_y = int(resolution_y)
    if samples:
        if scene.render.engine == "CYCLES":
            scene.cycles.samples = int(samples)
        else:
            try:
                scene.eevee.taa_render_samples = int(samples)
            except Exception:
                pass
    if camera:
        cam = bpy.data.objects.get(camera)
        if cam is None or cam.type != "CAMERA":
            raise ValueError(f"camera object not found: {camera}")
        scene.camera = cam
    if frame is not None:
        scene.frame_set(int(frame))
    scene.render.filepath = os.path.abspath(output_path)
    bpy.ops.render.render(write_still=True)
    return {"path": scene.render.filepath, "engine": scene.render.engine}


def _import_file(path: str):
    path = os.path.abspath(path)
    ext = os.path.splitext(path)[1].lower()
    before = {o.name for o in bpy.data.objects}
    if ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".stl":
        if hasattr(bpy.ops.wm, "stl_import"):
            bpy.ops.wm.stl_import(filepath=path)
        else:
            bpy.ops.import_mesh.stl(filepath=path)
    elif ext == ".ply":
        if hasattr(bpy.ops.wm, "ply_import"):
            bpy.ops.wm.ply_import(filepath=path)
        else:
            bpy.ops.import_mesh.ply(filepath=path)
    elif ext == ".dae":
        bpy.ops.wm.collada_import(filepath=path)
    else:
        raise ValueError(f"unsupported format: {ext}")
    added = [o.name for o in bpy.data.objects if o.name not in before]
    return {"imported": added, "path": path}


def _export_file(path: str, selection_only: bool = False):
    path = os.path.abspath(path)
    ext = os.path.splitext(path)[1].lower()
    if ext == ".obj":
        kw = {"filepath": path}
        if selection_only:
            kw["export_selected_objects"] = True
        bpy.ops.wm.obj_export(**kw)
    elif ext == ".fbx":
        kw = {"filepath": path}
        if selection_only:
            kw["use_selection"] = True
        bpy.ops.export_scene.fbx(**kw)
    elif ext in (".glb", ".gltf"):
        kw = {"filepath": path}
        if selection_only:
            kw["use_selection"] = True
        bpy.ops.export_scene.gltf(**kw)
    elif ext == ".stl":
        if hasattr(bpy.ops.wm, "stl_export"):
            kw = {"filepath": path}
            if selection_only:
                kw["export_selected_objects"] = True
            bpy.ops.wm.stl_export(**kw)
        else:
            kw = {"filepath": path}
            if selection_only:
                kw["use_selection"] = True
            bpy.ops.export_mesh.stl(**kw)
    elif ext == ".ply":
        if hasattr(bpy.ops.wm, "ply_export"):
            kw = {"filepath": path}
            if selection_only:
                kw["export_selected_objects"] = True
            bpy.ops.wm.ply_export(**kw)
        else:
            kw = {"filepath": path}
            if selection_only:
                kw["use_selection"] = True
            bpy.ops.export_mesh.ply(**kw)
    else:
        raise ValueError(f"unsupported format: {ext}")
    return {"path": path}


def _open_file(path: str):
    path = os.path.abspath(path)
    bpy.ops.wm.open_mainfile(filepath=path)
    return {"path": path}


def _save_file(path=None):
    if path:
        path = os.path.abspath(path)
        bpy.ops.wm.save_as_mainfile(filepath=path)
    else:
        if not bpy.data.filepath:
            raise ValueError("no path: current file has never been saved; pass path")
        bpy.ops.wm.save_mainfile()
    return {"path": path or bpy.data.filepath}


def _reset():
    bpy.ops.wm.read_factory_settings(use_empty=False)
    return {"ok": True}


def _execute(code: str):
    buf = io.StringIO()
    err_buf = io.StringIO()
    ns = {"bpy": bpy, "math": math, "os": os, "_result": None}
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(err_buf):
        exec(code, ns)
    result = ns.get("_result")
    try:
        json.dumps(result)
    except Exception:
        result = repr(result)
    return {
        "stdout": buf.getvalue(),
        "stderr": err_buf.getvalue(),
        "result": result,
    }


def _select(names=None, all_=False, none=False):
    if none:
        bpy.ops.object.select_all(action="DESELECT")
        return {"selected": []}
    if all_:
        bpy.ops.object.select_all(action="SELECT")
        return {"selected": [o.name for o in bpy.context.selected_objects]}
    bpy.ops.object.select_all(action="DESELECT")
    for n in names or []:
        obj = bpy.data.objects.get(n)
        if obj is None:
            raise ValueError(f"object not found: {n}")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
    return {"selected": [o.name for o in bpy.context.selected_objects]}


def _keyframe_insert(object_name: str, property: str, frame: int, value=None, interpolation=None):
    obj = bpy.data.objects.get(object_name)
    if obj is None:
        raise ValueError(f"object not found: {object_name}")
    if value is not None:
        if property == "location":
            obj.location = tuple(value)
        elif property == "rotation_euler":
            obj.rotation_euler = tuple(value)
        elif property == "scale":
            obj.scale = tuple(value)
        elif property == "hide_viewport" or property == "hide_render":
            setattr(obj, property, bool(value))
        else:
            # attribute-style path on the object
            if not hasattr(obj, property):
                raise ValueError(f"object has no property '{property}'")
            setattr(obj, property, value)
    bpy.context.scene.frame_set(int(frame))
    obj.keyframe_insert(data_path=property, frame=int(frame))
    # set interpolation on the last keyframe
    if interpolation and obj.animation_data and obj.animation_data.action:
        for fc in obj.animation_data.action.fcurves:
            if fc.data_path == property:
                if fc.keyframe_points:
                    fc.keyframe_points[-1].interpolation = interpolation.upper()
    return {"object": object_name, "property": property, "frame": int(frame)}


def _keyframe_delete(object_name: str, property: str, frame=None):
    obj = bpy.data.objects.get(object_name)
    if obj is None:
        raise ValueError(f"object not found: {object_name}")
    if frame is None:
        obj.keyframe_delete(data_path=property)
    else:
        obj.keyframe_delete(data_path=property, frame=int(frame))
    return {"object": object_name, "property": property, "frame": frame}


def _list_keyframes(object_name: str):
    obj = bpy.data.objects.get(object_name)
    if obj is None:
        raise ValueError(f"object not found: {object_name}")
    out = []
    if obj.animation_data and obj.animation_data.action:
        for fc in obj.animation_data.action.fcurves:
            kps = [{"frame": kp.co[0], "value": kp.co[1], "interpolation": kp.interpolation}
                   for kp in fc.keyframe_points]
            out.append({"data_path": fc.data_path, "array_index": fc.array_index, "keyframes": kps})
    return {"object": object_name, "fcurves": out}


def _set_frame(frame: int):
    bpy.context.scene.frame_set(int(frame))
    return {"frame": int(frame)}


def _frame_range(start: int, end: int, fps=None):
    sc = bpy.context.scene
    sc.frame_start = int(start)
    sc.frame_end = int(end)
    if fps is not None:
        sc.render.fps = int(fps)
    return {"frame_start": sc.frame_start, "frame_end": sc.frame_end, "fps": sc.render.fps}


def _add_modifier(object_name: str, mod_type: str, name=None, params=None):
    obj = bpy.data.objects.get(object_name)
    if obj is None:
        raise ValueError(f"object not found: {object_name}")
    if not hasattr(obj, "modifiers"):
        raise ValueError(f"object {object_name} does not support modifiers")
    mod = obj.modifiers.new(name=name or mod_type.capitalize(), type=mod_type.upper())
    unknown = []
    if params:
        for k, v in params.items():
            if not hasattr(mod, k):
                unknown.append(k)
                continue
            setattr(mod, k, v)
    return {
        "object": object_name,
        "name": mod.name,
        "type": mod.type,
        "unknown_params": unknown,
    }


def _remove_modifier(object_name: str, modifier_name: str):
    obj = bpy.data.objects.get(object_name)
    if obj is None:
        raise ValueError(f"object not found: {object_name}")
    mod = obj.modifiers.get(modifier_name)
    if mod is None:
        raise ValueError(f"modifier not found: {modifier_name} on {object_name}")
    obj.modifiers.remove(mod)
    return {"object": object_name, "removed": modifier_name}


def _list_modifiers(object_name: str):
    obj = bpy.data.objects.get(object_name)
    if obj is None:
        raise ValueError(f"object not found: {object_name}")
    mods = []
    for m in obj.modifiers:
        d = {"name": m.name, "type": m.type}
        # Common exposed params — skip RNA internals
        for attr in ("levels", "render_levels", "count", "width", "segments",
                     "thickness", "factor", "angle", "axis", "offset",
                     "use_mirror_u", "use_mirror_v", "operation", "solver"):
            if hasattr(m, attr):
                try:
                    v = getattr(m, attr)
                    if hasattr(v, "__iter__") and not isinstance(v, str):
                        v = list(v)
                    d[attr] = v
                except Exception:
                    pass
        mods.append(d)
    return {"object": object_name, "modifiers": mods}


def _camera_look_at(camera_name: str, target_name: str, track_axis="TRACK_NEGATIVE_Z", up_axis="UP_Y"):
    cam = bpy.data.objects.get(camera_name)
    if cam is None:
        raise ValueError(f"camera not found: {camera_name}")
    if cam.type != "CAMERA":
        raise ValueError(f"{camera_name} is not a CAMERA (type={cam.type})")
    target = bpy.data.objects.get(target_name)
    if target is None:
        raise ValueError(f"target not found: {target_name}")
    # Remove any existing TRACK_TO constraint
    for c in list(cam.constraints):
        if c.type == "TRACK_TO":
            cam.constraints.remove(c)
    cons = cam.constraints.new(type="TRACK_TO")
    cons.target = target
    cons.track_axis = track_axis
    cons.up_axis = up_axis
    return {"camera": camera_name, "target": target_name, "track_axis": track_axis, "up_axis": up_axis}


def _material(object_name: str, name=None, color=None, metallic=None, roughness=None):
    obj = bpy.data.objects.get(object_name)
    if obj is None:
        raise ValueError(f"object not found: {object_name}")
    mat_name = name or f"{object_name}_mat"
    mat = bpy.data.materials.get(mat_name) or bpy.data.materials.new(mat_name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        if color is not None:
            c = list(color)
            if len(c) == 3:
                c.append(1.0)
            bsdf.inputs["Base Color"].default_value = tuple(c)
        if metallic is not None:
            bsdf.inputs["Metallic"].default_value = float(metallic)
        if roughness is not None:
            bsdf.inputs["Roughness"].default_value = float(roughness)
    if obj.data and hasattr(obj.data, "materials"):
        if obj.material_slots:
            obj.material_slots[0].material = mat
        else:
            obj.data.materials.append(mat)
    return {"object": object_name, "material": mat.name}


HANDLERS = {
    "execute": lambda p: _execute(p["code"]),
    "scene": lambda p: _scene(),
    "create": lambda p: _create(p["primitive"], p.get("name"), p.get("location"), p.get("scale")),
    "delete": lambda p: _delete(p["name"]),
    "transform": lambda p: _transform(
        p["name"], p.get("location"), p.get("rotation_euler"), p.get("scale")
    ),
    "render": lambda p: _render(
        p["output_path"],
        p.get("resolution_x"),
        p.get("resolution_y"),
        p.get("samples"),
        p.get("engine"),
        p.get("camera"),
        p.get("frame"),
    ),
    "import_file": lambda p: _import_file(p["path"]),
    "export_file": lambda p: _export_file(p["path"], bool(p.get("selection_only", False))),
    "open": lambda p: _open_file(p["path"]),
    "save": lambda p: _save_file(p.get("path")),
    "reset": lambda p: _reset(),
    "select": lambda p: _select(p.get("names"), bool(p.get("all", False)), bool(p.get("none", False))),
    "material": lambda p: _material(
        p["object"], p.get("name"), p.get("color"), p.get("metallic"), p.get("roughness")
    ),
    "keyframe_insert": lambda p: _keyframe_insert(
        p["object"], p["property"], p["frame"], p.get("value"), p.get("interpolation"),
    ),
    "keyframe_delete": lambda p: _keyframe_delete(p["object"], p["property"], p.get("frame")),
    "list_keyframes": lambda p: _list_keyframes(p["object"]),
    "set_frame": lambda p: _set_frame(p["frame"]),
    "frame_range": lambda p: _frame_range(p["start"], p["end"], p.get("fps")),
    "add_modifier": lambda p: _add_modifier(p["object"], p["modifier_type"], p.get("name"), p.get("params")),
    "remove_modifier": lambda p: _remove_modifier(p["object"], p["modifier_name"]),
    "list_modifiers": lambda p: _list_modifiers(p["object"]),
    "camera_look_at": lambda p: _camera_look_at(p["camera"], p["target"], p.get("track_axis", "TRACK_NEGATIVE_Z"), p.get("up_axis", "UP_Y")),
}


def _serve_connection(conn: socket.socket) -> None:
    buf = b""
    while True:
        chunk = conn.recv(65536)
        if not chunk:
            return
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line.decode("utf-8"))
            except Exception as e:
                resp = {"id": None, "ok": False, "error": f"invalid json: {e}"}
                conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))
                continue
            rid = req.get("id")
            action = req.get("action")
            params = req.get("params") or {}
            handler = HANDLERS.get(action)
            try:
                if handler is None:
                    raise ValueError(f"unknown action: {action}")
                result = handler(params)
                resp = {"id": rid, "ok": True, "result": result}
            except Exception as e:
                resp = {
                    "id": rid,
                    "ok": False,
                    "error": f"{type(e).__name__}: {e}",
                    "traceback": traceback.format_exc(),
                }
            conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))


def main():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((HOST, PORT))
    sock.listen(1)
    print(f"BLENDER_MCP_READY port={PORT}", flush=True)
    try:
        while True:
            conn, _ = sock.accept()
            try:
                _serve_connection(conn)
            except (ConnectionResetError, BrokenPipeError):
                pass
            finally:
                conn.close()
    finally:
        sock.close()


main()
