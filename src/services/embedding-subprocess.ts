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

function isBunOrNodeExecutable(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === "bun" || name === "bun.exe" || name === "node" || name === "node.exe";
}

/**
 * Prefer Node so ORT runs outside Bun's NAPI host (#518). Fall back to a Bun
 * *subprocess* (still isolated from the OpenCode host) when Node is missing —
 * a child segfault kills only the worker, not `opencode serve`.
 */
export function resolveEmbeddingWorkerRuntime(): string | null {
  const node = which("node");
  if (node) return node;
  const bun = which("bun");
  if (bun) return bun;
  // Real Bun/Node process (not a foreign compiled host like opencode.exe).
  if (
    (typeof process.versions.bun === "string" || typeof process.versions.node === "string") &&
    isBunOrNodeExecutable(process.execPath)
  ) {
    return process.execPath;
  }
  return null;
}

export function resolveEmbeddingWorkerScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const asJs = join(here, "embedding-worker.js");
  if (existsSync(asJs)) return asJs;
  // Source checkout / bun test may resolve the .ts sibling.
  const asTs = join(here, "embedding-worker.ts");
  if (existsSync(asTs)) return asTs;
  return asJs;
}

/** Package root that owns `node_modules` next to the built worker. */
export function resolveEmbeddingWorkerPackageRoot(scriptPath: string): string | undefined {
  // dist/services/embedding-worker.js → package root
  const root = join(dirname(scriptPath), "..", "..");
  return existsSync(join(root, "package.json")) ? root : undefined;
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
  /** Override Node/Bun executable (tests). */
  runtimePath?: string;
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
  private readonly runtimePath?: string;
  private readonly requestTimeoutMs: number;

  constructor(options: EmbeddingSubprocessClientOptions = {}) {
    this.scriptPath = options.scriptPath;
    this.runtimePath = options.runtimePath;
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
    const runtime = this.runtimePath ?? resolveEmbeddingWorkerRuntime();
    const script = this.scriptPath ?? resolveEmbeddingWorkerScript();
    if (!runtime) {
      throw new Error(
        "Local embeddings on Windows require Node.js or Bun on PATH so onnxruntime can run in a subprocess (#518). Install Node.js, or configure remote embeddings via embeddingApiUrl + embeddingApiKey."
      );
    }
    if (!existsSync(script)) {
      throw new Error(`embedding-worker script not found at ${script}`);
    }

    if (script.endsWith(".ts") && /node(\.exe)?$/i.test(basename(runtime))) {
      throw new Error(
        `embedding-worker.ts cannot run under Node; build the plugin first (expected ${script.replace(/\.ts$/, ".js")})`
      );
    }

    const packageRoot = resolveEmbeddingWorkerPackageRoot(script);
    const nodePathParts = [
      packageRoot ? join(packageRoot, "node_modules") : null,
      process.env.NODE_PATH,
    ].filter((part): part is string => Boolean(part));

    const child = spawn(runtime, [script], {
      cwd: packageRoot,
      env: {
        ...process.env,
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

    log("embedding-subprocess started", { runtime, script, cwd: packageRoot ?? null });
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
