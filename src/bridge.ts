import { spawn, ChildProcess } from "node:child_process";
import { createConnection, Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CANDIDATES = [
  process.env.BLENDER_PATH,
  "C:/Program Files/Blender Foundation/Blender 4.4/blender.exe",
  "C:/Program Files/Blender Foundation/Blender 4.3/blender.exe",
  "C:/Program Files/Blender Foundation/Blender 4.2/blender.exe",
  "/Applications/Blender.app/Contents/MacOS/Blender",
  "/usr/bin/blender",
  "/usr/local/bin/blender",
  "blender",
].filter(Boolean) as string[];

function resolveBlender(): string {
  for (const c of CANDIDATES) {
    if (c === "blender") return c;
    if (existsSync(c)) return c;
  }
  return "blender";
}

const BLENDER_EXE = resolveBlender();
const BRIDGE_PY = resolve(__dirname, "..", "blender", "server.py");
const PORT = parseInt(process.env.BLENDER_MCP_PORT ?? "54321", 10);
const STARTUP_TIMEOUT_MS = parseInt(process.env.BLENDER_STARTUP_TIMEOUT ?? "60000", 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.BLENDER_REQUEST_TIMEOUT ?? "120000", 10);

type Pending = {
  id: number;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export class BlenderBridge {
  private proc?: ChildProcess;
  private sock?: Socket;
  private readyPromise?: Promise<void>;
  private buf = "";
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrBuf = "";

  async ensure(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.launch().catch((e) => {
      this.readyPromise = undefined;
      throw e;
    });
    return this.readyPromise;
  }

  private async launch(): Promise<void> {
    this.proc = spawn(
      BLENDER_EXE,
      ["--background", "--python", BRIDGE_PY],
      {
        env: { ...process.env, BLENDER_MCP_PORT: String(PORT) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    this.proc.on("exit", (code, signal) => {
      const err = new Error(`blender exited (code=${code}, signal=${signal})`);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.readyPromise = undefined;
      this.sock = undefined;
      this.proc = undefined;
    });

    this.proc.stderr!.on("data", (c) => {
      this.stderrBuf += c.toString("utf8");
      if (this.stderrBuf.length > 65536) {
        this.stderrBuf = this.stderrBuf.slice(-32768);
      }
    });

    await new Promise<void>((res, rej) => {
      const to = setTimeout(() => {
        rej(new Error(
          `blender startup timed out after ${STARTUP_TIMEOUT_MS}ms. stderr tail:\n${this.stderrBuf.slice(-2000)}`,
        ));
      }, STARTUP_TIMEOUT_MS);
      const onData = (chunk: Buffer) => {
        const s = chunk.toString("utf8");
        if (s.includes("BLENDER_MCP_READY")) {
          this.proc!.stdout!.off("data", onData);
          clearTimeout(to);
          res();
        }
      };
      this.proc!.stdout!.on("data", onData);
      this.proc!.once("exit", () => {
        clearTimeout(to);
        rej(new Error(`blender exited during startup. stderr tail:\n${this.stderrBuf.slice(-2000)}`));
      });
    });

    this.sock = createConnection({ host: "127.0.0.1", port: PORT });
    await new Promise<void>((res, rej) => {
      this.sock!.once("connect", () => res());
      this.sock!.once("error", rej);
    });
    this.sock.setKeepAlive(true);
    this.sock.on("data", (chunk) => this.onData(chunk));
    this.sock.on("error", (e) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(e);
      }
      this.pending.clear();
    });
  }

  private onData(chunk: Buffer) {
    this.buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let resp: any;
      try {
        resp = JSON.parse(line);
      } catch (e) {
        continue;
      }
      const id: number | undefined = resp.id;
      if (id === undefined) continue;
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (resp.ok) p.resolve(resp.result);
      else p.reject(new Error(resp.error + (resp.traceback ? `\n${resp.traceback}` : "")));
    }
  }

  async send(action: string, params: Record<string, unknown> = {}): Promise<any> {
    await this.ensure();
    if (!this.sock) throw new Error("blender socket not connected");
    const id = this.nextId++;
    const line = JSON.stringify({ id, action, params }) + "\n";
    return new Promise<any>((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`blender request timed out after ${REQUEST_TIMEOUT_MS}ms (action=${action})`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { id, resolve: res, reject: rej, timer });
      this.sock!.write(line, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          rej(err);
        }
      });
    });
  }

  shutdown() {
    try { this.sock?.end(); } catch {}
    try { this.proc?.kill(); } catch {}
  }
}

export const bridge = new BlenderBridge();

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    bridge.shutdown();
    process.exit(0);
  });
}
process.on("exit", () => bridge.shutdown());
