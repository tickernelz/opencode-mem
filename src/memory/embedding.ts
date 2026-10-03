import { CONFIG } from "../config.js";
import { log } from "../infra/logger.js";
import { join } from "node:path";
import {
  formatOnnxruntimeInitError,
  prepareOnnxruntimeForTransformers,
} from "../infra/onnxruntime-resolve.js";
import { createRuntimeRequire } from "../infra/runtime-require.js";

const requireFromHere = createRuntimeRequire(import.meta);

const TIMEOUT_MS = 30000;
const GLOBAL_EMBEDDING_KEY = Symbol.for("opencode-mem.embedding.instance");
const MAX_CACHE_SIZE = 100;

export type EmbeddingTask = "document" | "query";

export type EmbedOptions = {
  task?: EmbeddingTask;
};

const TASK_PREFIXES: Record<EmbeddingTask, string> = {
  document: "search_document: ",
  query: "search_query: ",
};

/**
 * Apply Nomic-style task prefixes when enabled.
 * Cache keys and API/local inputs should use the returned string.
 */
export function applyEmbeddingTaskPrefix(
  text: string,
  options?: EmbedOptions,
  useTaskPrefixes: boolean = CONFIG.embeddingUseTaskPrefixes
): string {
  if (!useTaskPrefixes || !options?.task) return text;
  const prefix = TASK_PREFIXES[options.task];
  if (text.startsWith(prefix)) return text;
  return `${prefix}${text}`;
}

type HfTransformers = typeof import("@huggingface/transformers");

let _transformers: {
  pipeline: HfTransformers["pipeline"];
  env: HfTransformers["env"];
} | null = null;

function getTransformersPackageSpecifier(): string {
  // Keep this non-literal so OpenCode/Bun plugin-loader bundling does not eagerly
  // traverse @huggingface/transformers internals during plugin startup. The package
  // is only needed for the local embedding backend, and should stay lazy.
  return ["@huggingface", "transformers"].join("/");
}

async function ensureTransformersLoaded(): Promise<NonNullable<typeof _transformers>> {
  if (_transformers !== null) return _transformers;
  // Pin onnxruntime-node (+ common) to our direct 1.30.0 stack before transformers
  // resolves them (#184 / #210 / #225). Load the CJS export so Module._resolveFilename
  // shim applies — the ESM entry's static import bypasses it under OpenCode nested installs.
  //
  // Critical ordering for OpenCode's Bun --compile host (#210 follow-up):
  // resolve the transformers absolute path BEFORE installOnnxruntimeResolveShim().
  // After the shim is installed, non-onnx Module._resolveFilename fallbacks fail with
  // `Cannot find module '@huggingface/transformers' from ''` even though the package
  // exists. Loading via the pre-resolved absolute path keeps the onnx pin shim active
  // for transformers' nested requires without needing a post-shim package resolve.
  const transformersSpecifier = getTransformersPackageSpecifier();
  let transformersEntry: string;
  try {
    transformersEntry = requireFromHere.resolve(transformersSpecifier);
  } catch (error) {
    throw new Error(
      `Cannot resolve ${transformersSpecifier} before installing the onnxruntime pin shim. ` +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  prepareOnnxruntimeForTransformers();
  const mod = requireFromHere(transformersEntry) as HfTransformers;
  mod.env.allowLocalModels = true;
  mod.env.allowRemoteModels = true;
  mod.env.cacheDir = join(CONFIG.storagePath, ".cache");
  // Keep ONNX WASM single-threaded for Bun/Node runtimes without SharedArrayBuffer.
  try {
    (mod.env as any).backends.onnx.wasm.numThreads = 1;
  } catch (e) {
    log("Failed to set wasm.numThreads", { error: String(e) });
  }
  _transformers = mod;
  return _transformers!;
}

/**
 * Production transformers load path used by nested OpenCode install fixtures (#210).
 * Prefer this over a separately anchored createRequire() so empty-referrer hosts are covered.
 */
export async function loadLocalTransformersBackend(): Promise<NonNullable<typeof _transformers>> {
  return ensureTransformersLoaded();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
  ]);
}

export class EmbeddingService {
  private pipe: any = null;
  private initPromise: Promise<void> | null = null;
  public isWarmedUp: boolean = false;
  /** Set when warmup fails permanently; prevents "initializing forever" (#184). */
  public initError: string | null = null;
  private cache: Map<string, Float32Array> = new Map();
  private cachedModelName: string | null = null;

  static getInstance(): EmbeddingService {
    if (!(globalThis as any)[GLOBAL_EMBEDDING_KEY]) {
      (globalThis as any)[GLOBAL_EMBEDDING_KEY] = new EmbeddingService();
    }
    return (globalThis as any)[GLOBAL_EMBEDDING_KEY];
  }

  async warmup(progressCallback?: (progress: any) => void): Promise<void> {
    if (this.isWarmedUp) return;
    if (this.initError) throw new Error(this.initError);
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initializeModel(progressCallback);
    return this.initPromise;
  }

  private async initializeModel(progressCallback?: (progress: any) => void): Promise<void> {
    try {
      if (CONFIG.embeddingApiUrl && CONFIG.embeddingApiKey) {
        // Send a probe request to verify the API endpoint is actually reachable
        // Uses a minimal embedding of "ping" to test the full request pipeline
        const probeResponse = await withTimeout(
          fetch(`${CONFIG.embeddingApiUrl}/embeddings`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${CONFIG.embeddingApiKey}`,
            },
            body: JSON.stringify({
              input: "ping",
              model: CONFIG.embeddingModel,
            }),
          }),
          TIMEOUT_MS
        );

        if (!probeResponse.ok) {
          throw new Error(
            `Embedding API health check failed: ${probeResponse.status} ${probeResponse.statusText}`
          );
        }

        this.isWarmedUp = true;
        this.initError = null;
        return;
      }

      // Local model path
      const { pipeline } = await ensureTransformersLoaded();
      this.pipe = await pipeline("feature-extraction", CONFIG.embeddingModel, {
        progress_callback: progressCallback,
      });
      this.isWarmedUp = true;
      this.initError = null;
      log("Embedding model warmed up", { model: CONFIG.embeddingModel });
    } catch (error) {
      const rewritten = formatOnnxruntimeInitError(error);
      this.initPromise = null;
      this.initError = rewritten.message;
      log("Failed to initialize embedding model", { error: rewritten.message });
      throw rewritten;
    }
  }

  async embed(text: string, options?: EmbedOptions): Promise<Float32Array> {
    if (this.cachedModelName !== CONFIG.embeddingModel) {
      this.clearCache();
      this.cachedModelName = CONFIG.embeddingModel;
    }

    const input = applyEmbeddingTaskPrefix(text, options);

    const cached = this.cache.get(input);
    if (cached) return cached;

    if (!this.isWarmedUp && !this.initPromise) {
      await this.warmup();
    }
    if (this.initPromise) {
      await this.initPromise;
    }

    let result: Float32Array;

    if (CONFIG.embeddingApiUrl && CONFIG.embeddingApiKey) {
      const response = await fetch(`${CONFIG.embeddingApiUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CONFIG.embeddingApiKey}`,
        },
        body: JSON.stringify({
          input,
          model: CONFIG.embeddingModel,
        }),
      });

      if (!response.ok) {
        throw new Error(`API embedding failed: ${response.statusText}`);
      }

      const data: any = await response.json();
      result = new Float32Array(data.data[0].embedding);
    } else {
      const output = await this.pipe(input, { pooling: "mean", normalize: true });
      result = new Float32Array(output.data);
    }

    if (this.cache.size >= MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(input, result);

    return result;
  }

  async embedWithTimeout(text: string, options?: EmbedOptions): Promise<Float32Array> {
    return withTimeout(this.embed(text, options), TIMEOUT_MS);
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export const embeddingService = EmbeddingService.getInstance();
