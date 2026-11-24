/**
 * Parent-side handle for the local-ONNX embedding subprocess (#518).
 *
 * Spawns a Node (preferred) or Bun child that runs `embedding-worker.ts` so
 * `onnxruntime-node` never loads in the OpenCode/Bun host. Dispose uses
 * SIGKILL so ORT's NAPI finalizer cannot crash the host on Windows.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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
};

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

/**
 * Prefer Node on Windows so ORT runs outside Bun's NAPI host (#518). Fall back
 * to Bun off-Windows (or when Node is missing and Bun can still spawn itself).
 */
export function resolveEmbeddingWorkerRuntime(): string | null {
  const node = which("node");
  if (node) return node;
  if (process.platform === "win32") {
    // Bun↔ORT in the OpenCode host is the failure mode; refuse an in-process
    // Bun worker on Windows when Node is unavailable.
    return null;
  }
  const bun = which("bun");
  if (bun) return bun;
  if (typeof process.versions.bun === "string" && /bun|node/i.test(process.execPath)) {
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
};

export class EmbeddingSubprocessClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stdoutQueue = Promise.resolve();
  private readonly scriptPath?: string;
  private readonly runtimePath?: string;

  constructor(options: EmbeddingSubprocessClientOptions = {}) {
    this.scriptPath = options.scriptPath;
    this.runtimePath = options.runtimePath;
  }

  async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed) return;

    const runtime = this.runtimePath ?? resolveEmbeddingWorkerRuntime();
    const script = this.scriptPath ?? resolveEmbeddingWorkerScript();
    if (!runtime) {
      throw new Error(
        "Local embeddings on Windows require Node.js on PATH so onnxruntime can run in a subprocess (#518). Install Node.js, or configure remote embeddings via embeddingApiUrl + embeddingApiKey."
      );
    }
    if (!existsSync(script)) {
      throw new Error(`embedding-worker script not found at ${script}`);
    }

    if (script.endsWith(".ts") && /node(\.exe)?$/i.test(runtime)) {
      throw new Error(
        `embedding-worker.ts cannot run under Node; build the plugin first (expected ${script.replace(/\.ts$/, ".js")})`
      );
    }

    const child = spawn(runtime, [script], {
      env: {
        ...process.env,
        OPENCODE_MEM_EMBEDDING_WORKER: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      this.stdoutQueue = this.stdoutQueue.then(() => {
        try {
          const response = parseWorkerResponse(line.trim());
          const waiter = this.pending.get(response.id);
          if (!waiter) return;
          this.pending.delete(response.id);
          waiter.resolve(response);
        } catch (error) {
          safeLog("embedding-subprocess: bad worker stdout", {
            error: String(error),
            line: line.slice(0, 200),
          });
        }
      });
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = String(chunk).trim();
      if (text) safeLog("embedding-subprocess stderr", { text: text.slice(0, 500) });
    });

    child.on("exit", (code, signal) => {
      const err = new Error(
        `embedding-worker exited (code=${code ?? "null"} signal=${signal ?? "null"})`
      );
      for (const [id, waiter] of this.pending) {
        this.pending.delete(id);
        waiter.reject(err);
      }
      this.child = null;
    });

    log("embedding-subprocess started", { runtime, script });
  }

  private request(message: EmbeddingWorkerRequest): Promise<EmbeddingWorkerResponse> {
    return new Promise((resolve, reject) => {
      const child = this.child;
      if (!child?.stdin) {
        reject(new Error("embedding-subprocess: not started"));
        return;
      }
      this.pending.set(message.id, { resolve, reject });
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          this.pending.delete(message.id);
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
  }

  async embed(text: string, pooling: string): Promise<Float32Array> {
    await this.ensureStarted();
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
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id);
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
