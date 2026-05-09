import { spawn, execFileSync, ChildProcess } from "node:child_process";
import { createConnection, Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

function discoverWindowsBlenderInstalls(): string[] {
  const out: string[] = [];
  const roots = [
    "C:/Program Files/Blender Foundation",
    "C:/Program Files (x86)/Blender Foundation",
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    // Sort descending so newer versions win.
    entries.sort().reverse();
    for (const e of entries) {
      if (!e.toLowerCase().startsWith("blender ")) continue;
      const exe = `${root}/${e}/blender.exe`;
      if (existsSync(exe)) out.push(exe);
    }
  }
  return out;
}

const CANDIDATES = [
  process.env.BLENDER_PATH,
  ...discoverWindowsBlenderInstalls(),
  // Fallbacks for known versions (sorted newest-first) in case discovery missed.
  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe",
  "C:/Program Files/Blender Foundation/Blender 4.5/blender.exe",
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

function parsePort(v: string | undefined, def: number): number {
  const raw = v ?? String(def);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    throw new Error(`invalid BLENDER_MCP_PORT: "${raw}" (must be 1..65535)`);
  }
  return n;
}

function parsePosInt(v: string | undefined, def: number, name: string): number {
  const raw = v ?? String(def);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid ${name}: "${raw}"`);
  }
  return n;
}

const PORT = parsePort(process.env.BLENDER_MCP_PORT, 54321);
const STARTUP_TIMEOUT_MS = parsePosInt(process.env.BLENDER_STARTUP_TIMEOUT, 60000, "BLENDER_STARTUP_TIMEOUT");
const REQUEST_TIMEOUT_MS = parsePosInt(process.env.BLENDER_REQUEST_TIMEOUT, 120000, "BLENDER_REQUEST_TIMEOUT");
// Per-launch shared secret. Any local process can connect to the loopback
// socket; without this, that means RCE via `execute`. Server.py reads the
// same env var and rejects unauthenticated requests.
const TOKEN = randomBytes(32).toString("hex");

function killProc(proc: ChildProcess): void {
  if (!proc.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { stdio: "ignore" });
      return;
    } catch {}
  }
  try { proc.kill("SIGKILL"); } catch {}
}

type Pending = {
  id: number;
  resolve: (v: unknown) => void;
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
      // --disable-autoexec disables auto-running of Python scripts embedded
      // in any .blend file we open. Combined with use_scripts=False on
      // wm.open_mainfile this closes the .blend RCE vector.
      ["--disable-autoexec", "--background", "--python", BRIDGE_PY],
      {
        env: {
          ...process.env,
          BLENDER_MCP_PORT: String(PORT),
          BLENDER_MCP_TOKEN: TOKEN,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    this.proc.on("exit", (code, signal) => {
      const err = new Error(
        `blender exited (code=${code}, signal=${signal}). stderr tail:\n${this.stderrBuf.slice(-2000)}`,
      );
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      // Clear the response buffer so partial data from the dead session
      // never bleeds into the next one (even though nextId is monotonic,
      // a stale partial JSON line could confuse the parser).
      this.buf = "";
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
        cleanup();
        rej(new Error(
          `blender startup timed out after ${STARTUP_TIMEOUT_MS}ms. stderr tail:\n${this.stderrBuf.slice(-2000)}`,
        ));
      }, STARTUP_TIMEOUT_MS);
      // Accumulate into a buffer — the marker may straddle chunk boundaries.
      let stdoutBuf = "";
      const onData = (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
        if (stdoutBuf.includes("BLENDER_MCP_READY")) {
          cleanup();
          res();
        }
        // Cap so a runaway Blender doesn't grow this unboundedly.
        if (stdoutBuf.length > 65536) stdoutBuf = stdoutBuf.slice(-32768);
      };
      const onExit = () => {
        cleanup();
        rej(new Error(`blender exited during startup. stderr tail:\n${this.stderrBuf.slice(-2000)}`));
      };
      // Single teardown to ensure no listener leaks regardless of which path
      // (ready / exit / timeout) settles the promise first.
      const cleanup = () => {
        clearTimeout(to);
        this.proc!.stdout!.off("data", onData);
        this.proc!.off("exit", onExit);
      };
      this.proc!.stdout!.on("data", onData);
      this.proc!.once("exit", onExit);
    });

    this.sock = createConnection({ host: "127.0.0.1", port: PORT });
    await new Promise<void>((res, rej) => {
      const onConn = () => {
        this.sock!.off("error", onErr);
        res();
      };
      const onErr = (e: Error) => {
        this.sock!.off("connect", onConn);
        // Kill the Blender proc so it doesn't stay orphaned when the TCP
        // connect fails (e.g. port already in use, or server.py exited
        // before binding). Without this, the proc accumulates on each retry.
        if (this.proc) {
          try { killProc(this.proc); } catch {}
          this.proc = undefined;
        }
        rej(e);
      };
      this.sock!.once("connect", onConn);
      this.sock!.once("error", onErr);
    });
    this.sock.setKeepAlive(true);
    this.sock.on("data", (chunk) => this.onData(chunk));
    const onDisconnect = (e: Error) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(e);
      }
      this.pending.clear();
      this.sock = undefined;
      this.readyPromise = undefined;
      // Also tear down the proc — leaving a stale `proc` reference means
      // the next ensure() short-circuits on `this.readyPromise` checks
      // elsewhere and request timeouts try to kill an already-dead PID.
      if (this.proc) {
        try { killProc(this.proc); } catch {}
        this.proc = undefined;
      }
    };
    this.sock.on("error", onDisconnect);
    this.sock.on("close", (hadError) => {
      if (this.sock) onDisconnect(new Error(`blender socket closed${hadError ? " with error" : ""}`));
    });
  }

  // Maximum bytes we'll buffer from blender before dropping. Protects
  // against a runaway blender that emits huge JSON without a newline
  // (e.g. an `execute` that returns megabytes of mesh data in one write).
  private static readonly MAX_BUF = 64 * 1024 * 1024; // 64 MB

  private onData(chunk: Buffer) {
    this.buf += chunk.toString("utf8");
    if (this.buf.length > BlenderBridge.MAX_BUF) {
      // Drop the oversized buffer and reject all pending requests so the
      // caller gets a clear error instead of silently hanging until timeout.
      const err = new Error(
        `blender response buffer overflow (>${BlenderBridge.MAX_BUF} bytes without newline)`,
      );
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.buf = "";
      return;
    }
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let resp: { id?: number; ok?: boolean; result?: unknown; error?: string; traceback?: string };
      try {
        resp = JSON.parse(line) as typeof resp;
      } catch (e) {
        process.stderr.write(`blender-mcp: bad json line: ${line.slice(0, 200)}\n`);
        continue;
      }
      const id: number | null | undefined = resp.id ?? null;
      // server.py emits {"id": null, "ok": false, "error": ...} when it
      // can't parse a request line. Without surfacing it, the bridge
      // silently drops the diagnostic and the request hangs until timeout.
      if (id == null) {
        if (resp.error) {
          process.stderr.write(`blender-mcp: server error (id=null): ${resp.error}\n`);
        }
        continue;
      }
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (resp.ok) p.resolve(resp.result);
      else p.reject(new Error((resp.error ?? "unknown error") + (resp.traceback ? `\n${resp.traceback}` : "")));
    }
  }

  async send(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    await this.ensure();
    // Snapshot before await/write — `this.sock` may be cleared by the
    // disconnect handler between the null check and `.write`.
    const sock = this.sock;
    if (!sock) throw new Error("blender socket not connected");
    const id = this.nextId++;
    // Token is attached as a top-level field; server.py validates before
    // dispatching the action.
    const line = JSON.stringify({ id, action, params, token: TOKEN }) + "\n";
    return new Promise<unknown>((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // The Blender process is still doing whatever it was doing (likely
        // a long-running render). Kill it so the user doesn't end up with a
        // zombie eating CPU/GPU; the next call will respawn.
        if (this.proc) {
          try { killProc(this.proc); } catch {}
        }
        // Mirror the exit handler — the proc.exit listener will eventually
        // run, but rejecting here without clearing leaves a window where
        // ensure() returns the stale readyPromise and send() writes to a
        // dead socket.
        this.pending.clear();
        this.readyPromise = undefined;
        this.sock = undefined;
        this.proc = undefined;
        rej(new Error(`blender request timed out after ${REQUEST_TIMEOUT_MS}ms (action=${action})`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { id, resolve: res, reject: rej, timer });
      sock.write(line, (err) => {
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
    try { if (this.proc) killProc(this.proc); } catch {}
    this.readyPromise = undefined;
  }
}

export const bridge = new BlenderBridge();

// SIGHUP doesn't exist on Windows — Node logs a warning ("Signal 'SIGHUP'
// is not supported") if you try to register it there.
const SIGNALS = process.platform === "win32"
  ? (["SIGINT", "SIGTERM"] as const)
  : (["SIGINT", "SIGTERM", "SIGHUP"] as const);
for (const sig of SIGNALS) {
  process.on(sig, () => {
    bridge.shutdown();
    process.exit(0);
  });
}
process.on("exit", () => bridge.shutdown());
