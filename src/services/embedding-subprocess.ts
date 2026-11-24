/**
 * Parent-side handle for the local-ONNX embedding subprocess (#518).
 *
 * Spawns a Node (preferred) or Bun child that runs `embedding-worker` so
 * `onnxruntime-node` never loads in the OpenCode/Bun host. Dispose uses
 * SIGKILL so ORT's NAPI finalizer cannot crash the host on Windows.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { log, safeLog } from "./logger.js";
import {
  parseWorkerResponse,
  type EmbeddingWorkerRequest,
  type EmbeddingWorkerResponse,
} from "./embedding-worker-protocol.js";

export type EmbeddingSubprocessWarmup = {
  model: string;
  cacheDir: string;
  pooling: string;
  dtype?: string;
};

type Pending = {
  resolve: (value: EmbeddingWorkerResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PluginImportMeta = ImportMeta & {
  path?: string;
  dirname?: string;
  dir?: string;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

function which(cmd: string): string | null {
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  const ext =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const e of ext) {
      const candidate = join(dir, `${cmd}${e}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** PATH plus well-known install locations (OpenCode sandboxes often omit PATH entries). */
export function resolveRuntimeCandidates(cmd: "node" | "bun"): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (path: string | null | undefined) => {
    if (!path || seen.has(path) || !existsSync(path)) return;
    seen.add(path);
    found.push(path);
  };

  add(which(cmd));

  const home = homedir();
  const local = process.env.LOCALAPPDATA;
  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";

  if (cmd === "node") {
    if (process.platform === "win32") {
      add(join(pf, "nodejs", "node.exe"));
      add(join(pf86, "nodejs", "node.exe"));
      if (local) add(join(local, "Programs", "nodejs", "node.exe"));
    } else {
      add("/usr/local/bin/node");
      add("/usr/bin/node");
      add(join(home, ".nvm", "current", "bin", "node"));
    }
  } else {
    if (process.platform === "win32") {
      add(join(home, ".bun", "bin", "bun.exe"));
      if (local) add(join(local, "bun", "bin", "bun.exe"));
    } else {
      add(join(home, ".bun", "bin", "bun"));
      add("/usr/local/bin/bun");
    }
  }

  return found;
}

function isBunOrNodeExecutable(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === "bun" || name === "bun.exe" || name === "node" || name === "node.exe";
}

export type EmbeddingWorkerRuntime = {
  /** Executable to spawn (node, bun, or a bun --compile host such as opencode.exe). */
  command: string;
  /** Extra argv before the worker script path. */
  args: string[];
  /** Extra env for the child (merged over process.env). */
  env: Record<string, string>;
};

/**
 * Prefer Node so ORT runs outside Bun's NAPI host (#518). Fall back to a Bun
 * *subprocess* (still isolated from the OpenCode host) when Node is missing —
 * a child segfault kills only the worker, not `opencode serve`.
 *
 * When only a Bun `--compile` host is available (typical OpenCode standalone
 * install with no Node/Bun on PATH), re-exec `process.execPath` with
 * `BUN_BE_BUN=1` so the child acts as the Bun CLI and can run our worker
 * script (Bun ≥ 1.2.16; OpenCode 2.3.x ships Bun 1.4.x).
 */
export function resolveEmbeddingWorkerRuntime(): EmbeddingWorkerRuntime | null {
  const node = resolveRuntimeCandidates("node")[0];
  if (node) return { command: node, args: [], env: {} };

  const bun = resolveRuntimeCandidates("bun")[0];
  if (bun) return { command: bun, args: [], env: {} };

  if (typeof process.versions.bun === "string" && process.execPath) {
    // OpenCode.exe / other bun --compile hosts: ignore the bundled entrypoint
    // and run our worker as plain `bun <script>`.
    return {
      command: process.execPath,
      args: [],
      env: { BUN_BE_BUN: "1" },
    };
  }

  if (typeof process.versions.node === "string" && isBunOrNodeExecutable(process.execPath)) {
    return { command: process.execPath, args: [], env: {} };
  }

  return null;
}

/** Directories that may contain the sibling embedding-worker script. */
export function collectEmbeddingWorkerDirs(meta: PluginImportMeta = import.meta): string[] {
  const dirs: string[] = [];
  const add = (dir: string | null | undefined) => {
    if (!dir || !dir.trim() || dir === "undefined") return;
    if (!dirs.includes(dir)) dirs.push(dir);
  };

  if (typeof meta.url === "string" && meta.url.trim()) {
    try {
      add(dirname(fileURLToPath(meta.url)));
    } catch {
      // OpenCode --compile hosts can expose unusable import.meta.url (#210).
    }
  }
  if (typeof meta.path === "string" && meta.path.trim()) add(dirname(meta.path));
  if (typeof meta.dirname === "string") add(meta.dirname);
  if (typeof meta.dir === "string") add(meta.dir);
  add(process.cwd());
  return dirs;
}

export function resolveEmbeddingWorkerScript(meta: PluginImportMeta = import.meta): string {
  for (const here of collectEmbeddingWorkerDirs(meta)) {
    const asJs = join(here, "embedding-worker.js");
    if (existsSync(asJs)) return asJs;
    const asTs = join(here, "embedding-worker.ts");
    if (existsSync(asTs)) return asTs;
  }
  throw new Error(
    "embedding-worker script not found next to the plugin module (OpenCode may have cleared import.meta.url; see #210 / #518). Reinstall the plugin or configure remote embeddings via embeddingApiUrl + embeddingApiKey."
  );
}

/** Package root that owns `node_modules` next to the built worker. */
export function resolveEmbeddingWorkerPackageRoot(scriptPath: string): string | undefined {
  let dir = dirname(scriptPath);
  for (let depth = 0; depth < 6; depth++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** True when local ONNX must not load in the host process. */
export function shouldUseEmbeddingSubprocess(): boolean {
  if (process.env.OPENCODE_MEM_EMBEDDING_SUBPROCESS === "0") return false;
  if (process.env.OPENCODE_MEM_EMBEDDING_SUBPROCESS === "1") return true;
  return process.platform === "win32";
}

export type EmbeddingSubprocessClientOptions = {
  /** Override worker script path (tests). */
  scriptPath?: string;
  /** Override resolved runtime (tests). */
  runtime?: EmbeddingWorkerRuntime;
  /** Per-request timeout (warmup/embed). */
  requestTimeoutMs?: number;
};

export class EmbeddingSubprocessClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private startPromise: Promise<void> | null = null;
  private modelReady = false;
  private readonly scriptPath?: string;
  private readonly runtimeOverride?: EmbeddingWorkerRuntime;
  private readonly requestTimeoutMs: number;

  constructor(options: EmbeddingSubprocessClientOptions = {}) {
    this.scriptPath = options.scriptPath;
    this.runtimeOverride = options.runtime;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** True after a successful warmup against the current child. */
  get isReady(): boolean {
    return this.modelReady && this.child !== null && !this.child.killed;
  }

  async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.spawnChild().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async spawnChild(): Promise<void> {
    const runtime = this.runtimeOverride ?? resolveEmbeddingWorkerRuntime();
    const script = this.scriptPath ?? resolveEmbeddingWorkerScript();
    if (!runtime) {
      throw new Error(
        "Local embeddings on Windows could not find a JS runtime for the ONNX subprocess (#518). Install Node.js, or configure remote embeddings via embeddingApiUrl + embeddingApiKey."
      );
    }
    if (!existsSync(script)) {
      throw new Error(`embedding-worker script not found at ${script}`);
    }

    if (script.endsWith(".ts") && /node(\.exe)?$/i.test(basename(runtime.command))) {
      throw new Error(
        `embedding-worker.ts cannot run under Node; build the plugin first (expected ${script.replace(/\.ts$/, ".js")})`
      );
    }

    const packageRoot = resolveEmbeddingWorkerPackageRoot(script);
    const nodePathParts = [
      packageRoot ? join(packageRoot, "node_modules") : null,
      process.env.NODE_PATH,
    ].filter((part): part is string => Boolean(part));

    const child = spawn(runtime.command, [...runtime.args, script], {
      cwd: packageRoot,
      env: {
        ...process.env,
        ...runtime.env,
        OPENCODE_MEM_EMBEDDING_WORKER: "1",
        // Keep protocol stdout clean; transformers/ORT chatter goes to stderr.
        TRANSFORMERS_VERBOSITY: process.env.TRANSFORMERS_VERBOSITY ?? "error",
        ...(nodePathParts.length > 0
          ? { NODE_PATH: nodePathParts.join(process.platform === "win32" ? ";" : ":") }
          : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.modelReady = false;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onSpawn = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        this.child = null;
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
      // Some runtimes omit 'spawn'; if pid is already set, treat as started.
      if (child.pid) onSpawn();
    });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      // Skip non-JSON chatter so accidental stdout from deps cannot hang IPC.
      if (trimmed[0] !== "{") {
        safeLog("embedding-subprocess: ignored non-JSON stdout", {
          line: trimmed.slice(0, 200),
        });
        return;
      }
      try {
        const response = parseWorkerResponse(trimmed);
        const waiter = this.pending.get(response.id);
        if (!waiter) return;
        this.pending.delete(response.id);
        clearTimeout(waiter.timer);
        waiter.resolve(response);
      } catch (error) {
        safeLog("embedding-subprocess: bad worker stdout", {
          error: String(error),
          line: trimmed.slice(0, 200),
        });
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = String(chunk).trim();
      if (text) safeLog("embedding-subprocess stderr", { text: text.slice(0, 500) });
    });

    child.on("exit", (code, signal) => {
      const err = new Error(
        `embedding-worker exited (code=${code ?? "null"} signal=${signal ?? "null"})`
      );
      this.modelReady = false;
      this.child = null;
      for (const [id, waiter] of this.pending) {
        this.pending.delete(id);
        clearTimeout(waiter.timer);
        waiter.reject(err);
      }
    });

    log("embedding-subprocess started", {
      runtime: runtime.command,
      bunBeBun: runtime.env.BUN_BE_BUN === "1",
      script,
      cwd: packageRoot ?? null,
    });
  }

  private request(message: EmbeddingWorkerRequest): Promise<EmbeddingWorkerResponse> {
    return new Promise((resolve, reject) => {
      const child = this.child;
      if (!child?.stdin) {
        reject(new Error("embedding-subprocess: not started"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(message.id);
        // A wedged ORT child must not keep running after we give up (#518).
        this.dispose("request-timeout");
        reject(new Error(`embedding-subprocess: timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      (timer as { unref?: () => void }).unref?.();

      this.pending.set(message.id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          const waiter = this.pending.get(message.id);
          if (waiter) {
            this.pending.delete(message.id);
            clearTimeout(waiter.timer);
          }
          reject(error);
        }
      });
    });
  }

  async warmup(options: EmbeddingSubprocessWarmup): Promise<void> {
    await this.ensureStarted();
    const id = this.nextId++;
    const response = await this.request({
      id,
      type: "warmup",
      model: options.model,
      cacheDir: options.cacheDir,
      pooling: options.pooling,
      ...(options.dtype ? { dtype: options.dtype } : {}),
    });
    if (!response.ok) throw new Error(response.error);
    this.modelReady = true;
  }

  async embed(text: string, pooling: string): Promise<Float32Array> {
    if (!this.isReady) {
      throw new Error("embedding-subprocess: worker not warmed up");
    }
    const id = this.nextId++;
    const response = await this.request({ id, type: "embed", text, pooling });
    if (!response.ok) throw new Error(response.error);
    if (!response.vector) throw new Error("embedding-subprocess: missing vector");
    return new Float32Array(response.vector);
  }

  /**
   * Kill the child hard. Do not await a graceful ORT dispose in-process — that
   * is what segfaults Bun on Windows (#518).
   */
  dispose(reason: string = "dispose"): void {
    const child = this.child;
    this.child = null;
    this.modelReady = false;
    this.startPromise = null;
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`embedding-subprocess disposed (${reason})`));
    }
    if (!child) return;
    try {
      child.kill("SIGKILL");
    } catch (error) {
      safeLog("embedding-subprocess kill failed", { error: String(error), reason });
    }
    safeLog("embedding-subprocess killed", { reason });
  }
}
