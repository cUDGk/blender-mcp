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

const vec3 = z.array(z.number()).length(3);

const server = new McpServer({
  name: "blender",
  version: "0.1.0",
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
    ]).describe("Action to perform"),
    code: z.string().optional().describe("Python code (execute). Use `_result = ...` to return a value."),
    primitive: z.enum([
      "cube","sphere","ico_sphere","plane","cone","cylinder","torus","monkey",
      "camera","light_point","light_sun","light_spot","light_area","empty",
    ]).optional().describe("Primitive kind (create)"),
    name: z.string().optional().describe("Object name (delete/transform) or new name (create/material)"),
    names: z.array(z.string()).optional().describe("Object names (select)"),
    all: z.boolean().optional().describe("Select all (select)"),
    none: z.boolean().optional().describe("Deselect all (select)"),
    location: vec3.optional().describe("[x,y,z] world location"),
    rotation_euler: vec3.optional().describe("[x,y,z] Euler rotation in radians"),
    scale: vec3.optional().describe("[x,y,z] scale"),
    object: z.string().optional().describe("Target object name (material)"),
    color: z.array(z.number()).min(3).max(4).optional().describe("RGB or RGBA (0..1) base color (material)"),
    metallic: z.number().min(0).max(1).optional().describe("Metallic 0..1 (material)"),
    roughness: z.number().min(0).max(1).optional().describe("Roughness 0..1 (material)"),
    output_path: z.string().optional().describe("Absolute output path (render)"),
    resolution_x: z.number().int().positive().optional().describe("Render width (render)"),
    resolution_y: z.number().int().positive().optional().describe("Render height (render)"),
    samples: z.number().int().positive().optional().describe("Render samples (render)"),
    engine: z.enum(["CYCLES", "BLENDER_EEVEE_NEXT", "BLENDER_WORKBENCH"]).optional().describe("Render engine (render)"),
    camera: z.string().optional().describe("Camera object name (render)"),
    frame: z.number().int().optional().describe("Frame to render (render)"),
    path: z.string().optional().describe("File path (import_file/export_file/open/save)"),
    selection_only: z.boolean().optional().describe("Export only selected objects (export_file)"),
  },
  async (params) => {
    const { action, ...rest } = params;
    try {
      const result = await bridge.send(action, rest as Record<string, unknown>);
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
