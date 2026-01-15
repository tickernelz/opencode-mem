import { pipeline, env } from "@xenova/transformers";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import { join } from "node:path";

env.allowLocalModels = true;
env.allowRemoteModels = true;
env.cacheDir = join(CONFIG.storagePath, ".cache");

const TIMEOUT_MS = 30000;
const GLOBAL_EMBEDDING_KEY = Symbol.for("opencode-mem.embedding.instance");

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

  static getInstance(): EmbeddingService {
    if (!(globalThis as any)[GLOBAL_EMBEDDING_KEY]) {
      (globalThis as any)[GLOBAL_EMBEDDING_KEY] = new EmbeddingService();
    }
    return (globalThis as any)[GLOBAL_EMBEDDING_KEY];
  }

  async warmup(progressCallback?: (progress: any) => void): Promise<void> {
    if (this.isWarmedUp) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.initializeModel(progressCallback);
    return this.initPromise;
  }

  private async initializeModel(progressCallback?: (progress: any) => void): Promise<void> {
    try {
      if (CONFIG.embeddingApiUrl && CONFIG.embeddingApiKey) {
        log("Using OpenAI-compatible API for embeddings");
        this.isWarmedUp = true;
        return;
      }

      log("Downloading embedding model", { model: CONFIG.embeddingModel });

      this.pipe = await pipeline("feature-extraction", CONFIG.embeddingModel, {
        progress_callback: progressCallback,
      });

      this.isWarmedUp = true;
      log("Embedding model ready");
    } catch (error) {
      this.initPromise = null;
      log("Failed to initialize embedding model", { error: String(error) });
      throw error;
    }
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.isWarmedUp && !this.initPromise) {
      await this.warmup();
    }

    if (this.initPromise) {
      await this.initPromise;
    }

    if (CONFIG.embeddingApiUrl && CONFIG.embeddingApiKey) {
      const response = await fetch(`${CONFIG.embeddingApiUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CONFIG.embeddingApiKey}`,
        },
        body: JSON.stringify({
          input: text,
          model: CONFIG.embeddingModel,
        }),
      });

      if (!response.ok) {
        throw new Error(`API embedding failed: ${response.statusText}`);
      }

      const data: any = await response.json();
      return new Float32Array(data.data[0].embedding);
    }

    const output = await this.pipe(text, { pooling: "mean", normalize: true });
    return new Float32Array(output.data);
  }

  async embedWithTimeout(text: string): Promise<Float32Array> {
    return withTimeout(this.embed(text), TIMEOUT_MS);
  }
}

export const embeddingService = EmbeddingService.getInstance();
