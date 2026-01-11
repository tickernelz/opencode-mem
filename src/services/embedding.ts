import { pipeline, env } from "@xenova/transformers";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";

env.allowLocalModels = true;
env.allowRemoteModels = true;
env.cacheDir = CONFIG.storagePath + "/.cache";

const TIMEOUT_MS = 30000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    ),
  ]);
}

export class EmbeddingService {
  private pipe: any = null;
  private initPromise: Promise<void> | null = null;
  public isWarmedUp: boolean = false;

  async warmup(progressCallback?: (progress: any) => void): Promise<void> {
    if (this.isWarmedUp) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        if (CONFIG.embeddingApiUrl && CONFIG.embeddingApiKey) {
          log("Using OpenAI-compatible API for embeddings");
          this.isWarmedUp = true;
          return;
        }

        log("Downloading embedding model", { model: CONFIG.embeddingModel });

        this.pipe = await pipeline(
          "feature-extraction",
          CONFIG.embeddingModel,
          { progress_callback: progressCallback }
        );

        this.isWarmedUp = true;
        log("Embedding model ready");
      } catch (error) {
        this.initPromise = null;
        log("Failed to initialize embedding model", { error: String(error) });
        throw error;
      }
    })();

    return this.initPromise;
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
          "Authorization": `Bearer ${CONFIG.embeddingApiKey}`,
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

export const embeddingService = new EmbeddingService();
