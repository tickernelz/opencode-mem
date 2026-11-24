/**
 * Local-ONNX embedding worker process.
 *
 * Run with `OPENCODE_MEM_EMBEDDING_WORKER=1` (or as `import.meta.main`). Loads
 * `@huggingface/transformers` / `onnxruntime-node` only in this address space.
 * The parent SIGKILLs us on shutdown so ORT's NAPI finalizer never runs in the
 * OpenCode/Bun host (#518).
 */

import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  prepareOnnxruntimeForTransformers,
  formatOnnxruntimeInitError,
} from "./onnxruntime-resolve.js";
import { createRuntimeRequire } from "./runtime-require.js";
import {
  getTransformersPackageSpecifier,
  resolveTransformersCjsEntry,
} from "./transformers-resolve.js";
import type {
  EmbeddingWorkerRequest,
  EmbeddingWorkerResponse,
} from "./embedding-worker-protocol.js";

const requireFromHere = createRuntimeRequire(import.meta);

type Pipe = {
  (text: string, opts: { pooling: string; normalize: boolean }): Promise<{ data: Float32Array }>;
  dispose?: () => Promise<void>;
};

let pipe: Pipe | null = null;

function send(response: EmbeddingWorkerResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

// Keep stdout reserved for JSON-line IPC; route casual logs to stderr.
console.log = (...args: unknown[]) => {
  process.stderr.write(`${args.map(String).join(" ")}\n`);
};
console.info = console.log;
console.debug = console.log;

async function loadPipeline(model: string, cacheDir: string, dtype?: string): Promise<Pipe> {
  const transformersSpecifier = getTransformersPackageSpecifier();
  const meta = import.meta as ImportMeta & { path?: string; dirname?: string; dir?: string };
  const transformersEntry = resolveTransformersCjsEntry({
    requireFn: requireFromHere,
    specifier: transformersSpecifier,
    startPaths: [meta.url, meta.path, meta.dirname, meta.dir, process.cwd()],
  });

  prepareOnnxruntimeForTransformers();
  const mod = requireFromHere(transformersEntry) as typeof import("@huggingface/transformers");
  mod.env.allowLocalModels = true;
  mod.env.allowRemoteModels = true;
  mod.env.cacheDir = cacheDir;
  try {
    (mod.env as any).backends.onnx.wasm.numThreads = 1;
  } catch {
    // Optional; wasm settings may be absent under the node ORT backend.
  }

  // Parent resolves dtype (config / cache probe) before spawn.
  const created = await mod.pipeline("feature-extraction", model, {
    ...(dtype ? { dtype: dtype as "fp32" | "fp16" | "q8" | "auto" } : {}),
  });
  return created as unknown as Pipe;
}

async function handle(request: EmbeddingWorkerRequest): Promise<void> {
  try {
    switch (request.type) {
      case "warmup": {
        if (pipe?.dispose) {
          try {
            await pipe.dispose();
          } catch {
            // Replace the previous pipeline even if dispose fails.
          }
        }
        pipe = await loadPipeline(
          request.model,
          request.cacheDir || join(process.cwd(), ".cache"),
          request.dtype
        );
        send({ id: request.id, ok: true });
        return;
      }
      case "embed": {
        if (!pipe) {
          send({ id: request.id, ok: false, error: "embedding-worker: not warmed up" });
          return;
        }
        const output = await pipe(request.text, {
          pooling: request.pooling,
          normalize: true,
        });
        send({ id: request.id, ok: true, vector: Array.from(output.data) });
        return;
      }
      case "dispose": {
        const current = pipe;
        pipe = null;
        if (current?.dispose) {
          try {
            await current.dispose();
          } catch {
            // Parent will SIGKILL us; best-effort dispose only.
          }
        }
        send({ id: request.id, ok: true });
        return;
      }
      default: {
        const unknown = request as { id?: number };
        send({
          id: typeof unknown.id === "number" ? unknown.id : -1,
          ok: false,
          error: "embedding-worker: unknown request type",
        });
      }
    }
  } catch (error) {
    const rewritten = formatOnnxruntimeInitError(error);
    send({
      id: request.id,
      ok: false,
      error: rewritten.message,
    });
  }
}

export async function runEmbeddingWorker(): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let request: EmbeddingWorkerRequest;
    try {
      request = JSON.parse(trimmed) as EmbeddingWorkerRequest;
    } catch (error) {
      send({
        id: -1,
        ok: false,
        error: `embedding-worker: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    await handle(request);
  }
}

const isWorkerMain =
  process.env.OPENCODE_MEM_EMBEDDING_WORKER === "1" ||
  (typeof import.meta !== "undefined" &&
    Boolean((import.meta as ImportMeta & { main?: boolean }).main));

if (isWorkerMain) {
  void runEmbeddingWorker().catch((error) => {
    send({
      id: -1,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
