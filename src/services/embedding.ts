import { CONFIG } from "../config.js";
import { log, safeLog } from "./logger.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatOnnxruntimeInitError,
  prepareOnnxruntimeForTransformers,
} from "./onnxruntime-resolve.js";
import { createRuntimeRequire } from "./runtime-require.js";

const requireFromHere = createRuntimeRequire(import.meta);

const TIMEOUT_MS = 30000;
const GLOBAL_EMBEDDING_KEY = Symbol.for("opencode-mem.embedding.instance");
const MAX_CACHE_SIZE = 100;
/**
 * Per-attempt ceiling for one remote embedding HTTP call. Kept at 8s so
 * 3 attempts + linear backoff stay under the outer embedWithTimeout budget
 * (TIMEOUT_MS = 30s). A single hung request costs one attempt instead of the
 * whole budget (#400: one transient hang previously aborted an entire import
 * with zero memories written).
 */
const REMOTE_ATTEMPT_TIMEOUT_MS = 8000;
/** Attempts per remote embedding call: 1 try + 2 retries on transient failures. */
const REMOTE_MAX_ATTEMPTS = 3;
/** Base backoff between remote embedding attempts; scales linearly (backoffMs * attempt). */
const REMOTE_RETRY_BACKOFF_MS = 500;

// ONNX weight variants in descending precision, mirroring transformers.js
// DEFAULT_DTYPE_SUFFIX_MAPPING (utils/dtypes.js). fp32 has no filename suffix.
const ONNX_DTYPE_VARIANTS = [
  ["fp32", ""],
  ["fp16", "_fp16"],
  ["q8", "_quantized"],
  ["int8", "_int8"],
  ["uint8", "_uint8"],
  ["q4", "_q4"],
  ["q4f16", "_q4f16"],
  ["bnb4", "_bnb4"],
  ["q2", "_q2"],
  ["q2f16", "_q2f16"],
  ["q1", "_q1"],
  ["q1f16", "_q1f16"],
] as const;

/** Concrete dtype strings accepted by transformers.js `pipeline({ dtype })`. */
export type LocalOnnxDtype = (typeof ONNX_DTYPE_VARIANTS)[number][0] | "auto";

type DeclaredDtype =
  { kind: "string"; value: LocalOnnxDtype } | { kind: "object" } | { kind: "absent" };

function modelCacheRoot(model: string, cacheRoot?: string): string {
  return join(cacheRoot ?? join(CONFIG.storagePath, ".cache"), model);
}

/**
 * Read `transformers.js_config.dtype` from the cached config.json.
 * String declarations outrank the cache probe. Object (per-file) maps must not
 * be overridden — transformers.js resolves them after loading config. Absent or
 * malformed configs fall through to the cache probe.
 */
function readDeclaredDtype(model: string, cacheRoot?: string): DeclaredDtype {
  try {
    const parsed = JSON.parse(
      readFileSync(join(modelCacheRoot(model, cacheRoot), "config.json"), "utf-8")
    );
    const declared = parsed?.["transformers.js_config"]?.dtype;
    if (typeof declared === "string" && declared.trim()) {
      return { kind: "string", value: declared.trim() as LocalOnnxDtype };
    }
    if (declared && typeof declared === "object" && !Array.isArray(declared)) {
      return { kind: "object" };
    }
    return { kind: "absent" };
  } catch {
    return { kind: "absent" };
  }
}

/**
 * Resolve the dtype whose ONNX weights are already cached, so a quantized-only
 * repo is not asked for `model.onnx` (fp32). Returns undefined when nothing is
 * cached yet — transformers.js then falls back to its own defaults.
 */
function detectCachedDtype(model: string, cacheRoot?: string): LocalOnnxDtype | undefined {
  const onnxDir = join(modelCacheRoot(model, cacheRoot), "onnx");
  const hit = ONNX_DTYPE_VARIANTS.find(([, suffix]) =>
    existsSync(join(onnxDir, `model${suffix}.onnx`))
  );
  return hit?.[0];
}

/**
 * Resolve a concrete dtype to pass into transformers.js `pipeline()`, or
 * undefined to leave dtype selection to transformers.js defaults / config.
 *
 * @param model Hugging Face model id (cache subdirectory under `.cache`)
 * @param cacheRoot Optional override for `{storagePath}/.cache` (tests)
 */
export function resolveLocalOnnxDtype(
  model: string,
  cacheRoot?: string
): LocalOnnxDtype | undefined {
  const declared = readDeclaredDtype(model, cacheRoot);
  if (declared.kind === "string") return declared.value;
  // Per-file object maps: do not pass options.dtype — it would override config.
  if (declared.kind === "object") return undefined;
  return detectCachedDtype(model, cacheRoot);
}

export type EmbeddingTask = "document" | "query";

export type EmbedOptions = {
  task?: EmbeddingTask;
};

const NOMIC_TASK_PREFIXES: Record<EmbeddingTask, string> = {
  document: "search_document: ",
  query: "search_query: ",
};

export type EmbeddingTaskPrefixOptions = {
  useTaskPrefixes?: boolean;
  queryPrefix?: string;
  documentPrefix?: string;
};

/**
 * Resolve the prefix for a task: explicit/custom → Nomic (when enabled) → none.
 * Empty string means "no prefix" (disables Nomic fallback for that task).
 */
export function resolveEmbeddingTaskPrefix(
  task: EmbeddingTask,
  options: EmbeddingTaskPrefixOptions = {}
): string {
  const custom = task === "query" ? options.queryPrefix : options.documentPrefix;
  if (custom !== undefined) return custom;
  if (options.useTaskPrefixes) return NOMIC_TASK_PREFIXES[task];
  return "";
}

/**
 * Apply task prefixes when configured.
 * Cache keys and API/local inputs should use the returned string.
 *
 * Third argument accepts the legacy boolean (`useTaskPrefixes`) or an options
 * object. Defaults read from CONFIG (custom/preset prefixes + Nomic flag).
 */
export function applyEmbeddingTaskPrefix(
  text: string,
  options?: EmbedOptions,
  useTaskPrefixesOrOpts: boolean | EmbeddingTaskPrefixOptions = {
    useTaskPrefixes: CONFIG.embeddingUseTaskPrefixes,
    queryPrefix: CONFIG.embeddingQueryPrefix,
    documentPrefix: CONFIG.embeddingDocumentPrefix,
  }
): string {
  if (!options?.task) return text;

  const prefixOpts: EmbeddingTaskPrefixOptions =
    typeof useTaskPrefixesOrOpts === "boolean"
      ? {
          useTaskPrefixes: useTaskPrefixesOrOpts,
          queryPrefix: CONFIG.embeddingQueryPrefix,
          documentPrefix: CONFIG.embeddingDocumentPrefix,
        }
      : {
          useTaskPrefixes: useTaskPrefixesOrOpts.useTaskPrefixes ?? CONFIG.embeddingUseTaskPrefixes,
          queryPrefix: useTaskPrefixesOrOpts.queryPrefix ?? CONFIG.embeddingQueryPrefix,
          documentPrefix: useTaskPrefixesOrOpts.documentPrefix ?? CONFIG.embeddingDocumentPrefix,
        };

  const prefix = resolveEmbeddingTaskPrefix(options.task, prefixOpts);
  if (!prefix) return text;
  if (text.startsWith(prefix)) return text;
  return `${prefix}${text}`;
}

function embeddingCacheFingerprint(): string {
  return [
    CONFIG.embeddingModel,
    CONFIG.embeddingPooling,
    CONFIG.embeddingQueryPrefix ?? "",
    CONFIG.embeddingDocumentPrefix ?? "",
    CONFIG.embeddingUseTaskPrefixes ? "1" : "0",
    CONFIG.embeddingDtype ?? "",
  ].join("\0");
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

/** Remote embedding call failed with an HTTP status. */
export class EmbeddingHttpError extends Error {
  constructor(
    public readonly status: number,
    statusText: string
  ) {
    super(`API embedding failed: ${status} ${statusText}`);
    this.name = "EmbeddingHttpError";
  }
}

/**
 * Classify an embedding fetch failure as retryable. Only transient conditions
 * are retried: HTTP 429/5xx, per-attempt AbortSignal timeouts, and network
 * TypeErrors from fetch. JSON parse errors, other 4xx, and unexpected errors
 * fail fast so programming/shape bugs are not amplified across attempts.
 */
function isRetryableEmbeddingError(error: unknown): boolean {
  if (error instanceof EmbeddingHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  if (error instanceof DOMException) {
    return error.name === "TimeoutError" || error.name === "AbortError";
  }
  // fetch network failures surface as TypeError; AbortSignal.timeout may too
  // depending on runtime (Bun/Node) — accept TimeoutError/AbortError names.
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return true;
    if (error instanceof TypeError) return true;
  }
  return false;
}

/**
 * Perform a remote embedding request with bounded retries. Each attempt uses
 * AbortSignal.timeout so a hung connection is cancelled (not orphaned via
 * Promise.race); transient failures (network, abort/timeout, 429, 5xx) are
 * retried with linear backoff, everything else fails fast.
 *
 * `fetchImpl` is injectable for tests.
 */
export async function fetchRemoteEmbeddingWithRetry(
  fetchImpl: typeof fetch,
  input: string,
  options: {
    url?: string;
    apiKey?: string;
    model?: string;
    attemptTimeoutMs?: number;
    maxAttempts?: number;
    backoffMs?: number;
  } = {}
): Promise<any> {
  const url = options.url ?? CONFIG.embeddingApiUrl;
  const apiKey = options.apiKey ?? CONFIG.embeddingApiKey;
  const model = options.model ?? CONFIG.embeddingModel;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? REMOTE_ATTEMPT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? REMOTE_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? REMOTE_RETRY_BACKOFF_MS;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchImpl(`${url}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ input, model }),
        signal: AbortSignal.timeout(attemptTimeoutMs),
      });
      if (!response.ok) {
        throw new EmbeddingHttpError(response.status, response.statusText);
      }
      try {
        return await response.json();
      } catch (parseError) {
        throw new Error("Invalid embedding API JSON", { cause: parseError });
      }
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isRetryableEmbeddingError(error)) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export class EmbeddingService {
  private pipe: any = null;
  private initPromise: Promise<void> | null = null;
  public isWarmedUp: boolean = false;
  /** Set when warmup fails permanently; prevents "initializing forever" (#184). */
  public initError: string | null = null;
  private cache: Map<string, Float32Array> = new Map();
  private cachedFingerprint: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = 0;
  /** Release requested while an embed held the pipeline; runs when it drains. */
  private pendingDispose: string | null = null;
  /** Bumped by dispose so a slow initialize cannot resurrect a released pipeline. */
  private generation = 0;

  static getInstance(): EmbeddingService {
    if (!(globalThis as any)[GLOBAL_EMBEDDING_KEY]) {
      (globalThis as any)[GLOBAL_EMBEDDING_KEY] = new EmbeddingService();
    }
    return (globalThis as any)[GLOBAL_EMBEDDING_KEY];
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleDispose(): void {
    this.clearIdleTimer();
    // Remote embeddings hold no model in-process, so there is nothing to release.
    if ((CONFIG.embeddingApiUrl && CONFIG.embeddingApiKey) || !this.isWarmedUp) return;
    const ms = CONFIG.embeddingIdleTimeoutMs;
    if (!(ms > 0)) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.dispose("idle-timeout");
    }, ms);
    (this.idleTimer as any).unref?.();
  }

  /** Drop the local pipeline so its weights can be reclaimed; the next embed() re-warms it. */
  async dispose(reason: string = "dispose"): Promise<void> {
    this.clearIdleTimer();
    if (this.inFlight > 0) {
      // A running embed still holds the pipeline; release once it drains.
      this.pendingDispose = reason;
      return;
    }
    this.generation++;
    const pipe = this.pipe;
    this.pipe = null;
    this.isWarmedUp = false;
    this.initPromise = null;
    this.initError = null;
    if (pipe?.dispose) {
      try {
        await pipe.dispose();
      } catch (error) {
        safeLog("Failed to dispose embedding pipeline", { error: String(error) });
      }
    }
    // Teardown path: a logger failure must not escape the idle timer or close().
    safeLog("Embedding model released", { reason, model: CONFIG.embeddingModel });
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
        // Send a probe request to verify the API endpoint is actually reachable.
        // Uses a minimal embedding of "ping" to test the full request pipeline.
        // Retried on transient failure (#400): a single hung probe previously
        // burned the whole 30s budget and set the sticky initError.
        await fetchRemoteEmbeddingWithRetry(fetch, "ping");
        this.isWarmedUp = true;
        this.initError = null;
        return;
      }

      // Local model path
      const generation = this.generation;
      const { pipeline } = await ensureTransformersLoaded();
      // Explicit config wins; otherwise auto-resolve from model declaration / cache (#393).
      const dtype = CONFIG.embeddingDtype ?? resolveLocalOnnxDtype(CONFIG.embeddingModel);
      if (dtype) {
        log("Resolved local ONNX dtype for embedding warmup", {
          model: CONFIG.embeddingModel,
          dtype,
          source: CONFIG.embeddingDtype ? "config" : "auto",
        });
      }
      const pipe = await pipeline("feature-extraction", CONFIG.embeddingModel, {
        ...(dtype ? { dtype } : {}),
        progress_callback: progressCallback,
      });
      if (generation !== this.generation) {
        // dispose() ran while the model was loading; keep nothing resident.
        await (pipe as any).dispose?.();
        return;
      }
      this.pipe = pipe;
      this.isWarmedUp = true;
      this.initError = null;
      this.scheduleIdleDispose();
      log("Embedding model warmed up", {
        model: CONFIG.embeddingModel,
        pooling: CONFIG.embeddingPooling,
        dtype: dtype ?? null,
      });
    } catch (error) {
      const rewritten = formatOnnxruntimeInitError(error);
      this.initPromise = null;
      this.initError = rewritten.message;
      log("Failed to initialize embedding model", { error: rewritten.message });
      throw rewritten;
    }
  }

  async embed(text: string, options?: EmbedOptions): Promise<Float32Array> {
    const fingerprint = embeddingCacheFingerprint();
    if (this.cachedFingerprint !== fingerprint) {
      this.clearCache();
      this.cachedFingerprint = fingerprint;
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

    this.inFlight++;
    try {
      let result: Float32Array;

      if (CONFIG.embeddingApiUrl && CONFIG.embeddingApiKey) {
        const data: any = await fetchRemoteEmbeddingWithRetry(fetch, input);
        result = new Float32Array(data.data[0].embedding);
      } else {
        const pipe = this.pipe;
        if (!pipe) {
          throw new Error("Embedding model was released before the request ran");
        }
        const output = await pipe(input, {
          pooling: CONFIG.embeddingPooling,
          normalize: true,
        });
        result = new Float32Array(output.data);
      }

      if (this.cache.size >= MAX_CACHE_SIZE) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey !== undefined) this.cache.delete(firstKey);
      }
      this.cache.set(input, result);

      return result;
    } finally {
      this.inFlight--;
      if (this.pendingDispose) {
        const reason = this.pendingDispose;
        this.pendingDispose = null;
        void this.dispose(reason);
      } else {
        this.scheduleIdleDispose();
      }
    }
  }

  async embedWithTimeout(text: string, options?: EmbedOptions): Promise<Float32Array> {
    return withTimeout(this.embed(text, options), TIMEOUT_MS);
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export const embeddingService = EmbeddingService.getInstance();
