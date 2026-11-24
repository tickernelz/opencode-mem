/**
 * JSON-line IPC between the embedding parent and the local-ONNX subprocess.
 *
 * On Windows, loading `onnxruntime-node` inside the OpenCode/Bun host segfaults
 * (#518 / oven-sh/bun#28008). The parent keeps the protocol; the child alone
 * loads transformers + ORT and is SIGKILL'd on dispose so NAPI finalizers
 * never run in the host address space.
 */

export type EmbeddingWorkerWarmupRequest = {
  id: number;
  type: "warmup";
  model: string;
  cacheDir: string;
  pooling: string;
  dtype?: string;
};

export type EmbeddingWorkerEmbedRequest = {
  id: number;
  type: "embed";
  text: string;
  pooling: string;
};

export type EmbeddingWorkerDisposeRequest = {
  id: number;
  type: "dispose";
};

export type EmbeddingWorkerRequest =
  EmbeddingWorkerWarmupRequest | EmbeddingWorkerEmbedRequest | EmbeddingWorkerDisposeRequest;

export type EmbeddingWorkerOkResponse = {
  id: number;
  ok: true;
  vector?: number[];
};

export type EmbeddingWorkerErrorResponse = {
  id: number;
  ok: false;
  error: string;
};

export type EmbeddingWorkerResponse = EmbeddingWorkerOkResponse | EmbeddingWorkerErrorResponse;

export function parseWorkerResponse(line: string): EmbeddingWorkerResponse {
  const parsed = JSON.parse(line) as EmbeddingWorkerResponse;
  if (typeof parsed?.id !== "number" || typeof parsed?.ok !== "boolean") {
    throw new Error(`embedding-worker: invalid response: ${line.slice(0, 200)}`);
  }
  return parsed;
}
