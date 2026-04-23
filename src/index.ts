#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { bridge } from "./bridge.js";

function textContent(data: unknown) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function errContent(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

/**
 * 一部の MCP クライアント (Claude Code の LLM ツール呼び出しパス等) が
 * オブジェクト / 配列の引数を JSON 文字列化してから渡す事がある。
 * 文字列で届いた場合は JSON.parse してから返す。
 * 既に object / array ならそのまま。undefined/null はそのまま undefined。
 */
function coerceObject<T>(v: unknown): T | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return undefined;
    try {
      return JSON.parse(s) as T;
    } catch {
      // parse 失敗時は undefined にせず、元の文字列を落とすのは呼び出し側責任
      return undefined;
    }
  }
  return v as T;
}

// 本来の型 + 文字列化版 も受け入れる。LLM には第一候補 (array/object) が
// 表示されるが、実行時に coerceObject で戻す。
const vec3 = z.union([z.array(z.number()).length(3), z.string()]);
const namesSchema = z.union([z.array(z.string()), z.string()]);
const colorSchema = z.union([z.array(z.number()).min(3).max(4), z.string()]);
const paramsSchema = z.union([z.record(z.any()), z.string()]);

const server = new McpServer({
  name: "blender",
  version: "0.2.1",
});

server.tool(
  "blender",
  `Control a persistent headless Blender instance via its Python API.

Blender launches on first call and is reused across calls (fast — no per-call startup cost).

Actions:
- execute: run arbitrary Python inside Blender (full bpy access). Assign to _result to return a value. stdout/stderr are captured.
- scene: dump scene graph as JSON (objects, transforms, materials, meshes, collections).
- create: add a primitive. primitive ∈ cube|sphere|ico_sphere|plane|cone|cylinder|torus|monkey|camera|light_point|light_sun|light_spot|light_area|empty.
- delete: remove object by name.
- transform: set location / rotation_euler (radians) / scale on a named object.
- select: select objects by names, or all=true / none=true.
- material: create/update a Principled BSDF material on an object. color=[r,g,b] (0..1), metallic, roughness.
- render: render current scene to output_path. engine ∈ CYCLES|BLENDER_EEVEE_NEXT|BLENDER_WORKBENCH. Optional resolution_x/y, samples, camera (object name), frame.
- import_file / export_file: .obj / .fbx / .glb / .gltf / .stl / .ply (.dae import only).
- open: load a .blend file.
- save: save current file; pass path to save-as.
- reset: factory reset (new empty scene).

Use 'scene' first to inspect state, then combine declarative actions (create/transform/render). Fall back to 'execute' for anything not covered.`,
  {
    action: z.enum([
      "execute",
      "scene",
      "create",
      "delete",
      "transform",
      "select",
      "material",
      "render",
      "import_file",
      "export_file",
      "open",
      "save",
      "reset",
      "keyframe_insert",
      "keyframe_delete",
      "list_keyframes",
      "set_frame",
      "frame_range",
      "add_modifier",
      "remove_modifier",
      "list_modifiers",
      "camera_look_at",
    ]).describe("Action to perform"),
    code: z.string().optional().describe("Python code (execute). Use `_result = ...` to return a value."),
    primitive: z.enum([
      "cube","sphere","ico_sphere","plane","cone","cylinder","torus","monkey",
      "camera","light_point","light_sun","light_spot","light_area","empty",
    ]).optional().describe("Primitive kind (create)"),
    name: z.string().optional().describe("Object name (delete/transform) or new name (create/material)"),
    names: namesSchema.optional().describe("Object names (select)"),
    all: z.boolean().optional().describe("Select all (select)"),
    none: z.boolean().optional().describe("Deselect all (select)"),
    location: vec3.optional().describe("[x,y,z] world location"),
    rotation_euler: vec3.optional().describe("[x,y,z] Euler rotation in radians"),
    scale: vec3.optional().describe("[x,y,z] scale"),
    object: z.string().optional().describe("Target object name (material)"),
    color: colorSchema.optional().describe("RGB or RGBA (0..1) base color (material)"),
    metallic: z.number().min(0).max(1).optional().describe("Metallic 0..1 (material)"),
    roughness: z.number().min(0).max(1).optional().describe("Roughness 0..1 (material)"),
    output_path: z.string().optional().describe("Absolute output path (render)"),
    resolution_x: z.number().int().positive().optional().describe("Render width (render)"),
    resolution_y: z.number().int().positive().optional().describe("Render height (render)"),
    samples: z.number().int().positive().optional().describe("Render samples (render)"),
    engine: z.enum(["CYCLES", "BLENDER_EEVEE_NEXT", "BLENDER_WORKBENCH"]).optional().describe("Render engine (render)"),
    camera: z.string().optional().describe("Camera object name (render)"),
    frame: z.number().int().optional().describe("Frame (render / keyframe_insert / keyframe_delete / set_frame)"),
    path: z.string().optional().describe("File path (import_file/export_file/open/save)"),
    selection_only: z.boolean().optional().describe("Export only selected objects (export_file)"),
    property: z.string().optional().describe("keyframe_*: property (location/rotation_euler/scale/hide_viewport/...)"),
    value: z.any().optional().describe("keyframe_insert: new value to set before inserting"),
    interpolation: z.enum(["CONSTANT", "LINEAR", "BEZIER", "SINE", "QUAD", "CUBIC", "QUART", "QUINT", "EXPO", "CIRC", "BACK", "BOUNCE", "ELASTIC"]).optional().describe("keyframe_insert: set the last keyframe's interpolation"),
    start: z.number().int().optional().describe("frame_range: scene.frame_start"),
    end: z.number().int().optional().describe("frame_range: scene.frame_end"),
    fps: z.number().int().optional().describe("frame_range: scene.render.fps"),
    modifier_type: z.string().optional().describe("add_modifier: Blender modifier type (BEVEL/SUBSURF/ARRAY/SOLIDIFY/MIRROR/BOOLEAN/DECIMATE/WAVE/SMOOTH/SKIN/REMESH/SCREW/SHRINKWRAP/LATTICE/...)"),
    modifier_name: z.string().optional().describe("remove_modifier: modifier name"),
    params: paramsSchema.optional().describe("add_modifier: modifier attribute name→value (e.g. {levels: 2, render_levels: 3} for SUBSURF)"),
    target: z.string().optional().describe("camera_look_at: target object name"),
    track_axis: z.string().optional().describe("camera_look_at: track axis (default TRACK_NEGATIVE_Z)"),
    up_axis: z.string().optional().describe("camera_look_at: up axis (default UP_Y)"),
  },
  async (params) => {
    const { action, ...rest } = params;
    try {
      // object/array 型フィールドは文字列で届く可能性があるので coerceObject で戻す。
      // Python 側は dict/list を期待するので、文字列のままでは送らない。
      const normalized: Record<string, unknown> = { ...rest };
      const arrayKeys = ["names", "location", "rotation_euler", "scale", "color"] as const;
      for (const k of arrayKeys) {
        if (k in normalized) {
          const coerced = coerceObject<unknown[]>(normalized[k]);
          if (coerced === undefined) delete normalized[k];
          else normalized[k] = coerced;
        }
      }
      if ("params" in normalized) {
        const coerced = coerceObject<Record<string, unknown>>(normalized.params);
        if (coerced === undefined) delete normalized.params;
        else normalized.params = coerced;
      }
      // keyframe_insert の value は z.any() で配列・オブジェクトも受け付けるが、
      // LLM が [0,0,5] を "[0,0,5]" として渡す経路があり得るので同様に戻す。
      if ("value" in normalized && typeof normalized.value === "string") {
        const s = (normalized.value as string).trim();
        if (s.startsWith("[") || s.startsWith("{")) {
          try {
            normalized.value = JSON.parse(s);
          } catch {
            // parse できなければ元の文字列のまま (スカラー文字列として意味がある場合もある)
          }
        }
      }
      const result = await bridge.send(action, normalized);
      return textContent(result);
    } catch (err) {
      return errContent(err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
