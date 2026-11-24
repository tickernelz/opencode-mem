import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  EmbeddingSubprocessClient,
  resolveEmbeddingWorkerRuntime,
  shouldUseEmbeddingSubprocess,
} from "../src/services/embedding-subprocess.js";
import { parseWorkerResponse } from "../src/services/embedding-worker-protocol.js";

const originalSubprocessEnv = process.env.OPENCODE_MEM_EMBEDDING_SUBPROCESS;
const originalPlatform = process.platform;

afterEach(() => {
  if (originalSubprocessEnv === undefined) {
    delete process.env.OPENCODE_MEM_EMBEDDING_SUBPROCESS;
  } else {
    process.env.OPENCODE_MEM_EMBEDDING_SUBPROCESS = originalSubprocessEnv;
  }
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

describe("shouldUseEmbeddingSubprocess", () => {
  it("defaults to true on win32 and false elsewhere", () => {
    delete process.env.OPENCODE_MEM_EMBEDDING_SUBPROCESS;
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(shouldUseEmbeddingSubprocess()).toBe(true);
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(shouldUseEmbeddingSubprocess()).toBe(false);
  });

  it("honours OPENCODE_MEM_EMBEDDING_SUBPROCESS overrides", () => {
    process.env.OPENCODE_MEM_EMBEDDING_SUBPROCESS = "1";
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(shouldUseEmbeddingSubprocess()).toBe(true);
    process.env.OPENCODE_MEM_EMBEDDING_SUBPROCESS = "0";
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(shouldUseEmbeddingSubprocess()).toBe(false);
  });
});

describe("EmbeddingSubprocessClient readiness", () => {
  it("rejects embed before warmup and after worker exit", async () => {
    const runtime = resolveEmbeddingWorkerRuntime();
    if (!runtime) return;

    const client = new EmbeddingSubprocessClient({
      runtimePath: runtime,
      scriptPath: join(import.meta.dir, "fixtures", "embedding-worker-fake.mjs"),
      requestTimeoutMs: 5_000,
    });

    expect(client.isReady).toBe(false);
    await expect(client.embed("x", "mean")).rejects.toThrow(/not warmed up/);

    await client.warmup({ model: "fake", cacheDir: "/tmp", pooling: "mean" });
    expect(client.isReady).toBe(true);
    expect(Array.from(await client.embed("ab", "mean"))).toEqual([2, 3, 4]);

    client.dispose("test-exit");
    expect(client.isReady).toBe(false);
  });
});

describe("parseWorkerResponse", () => {
  it("accepts ok and error payloads", () => {
    expect(parseWorkerResponse(JSON.stringify({ id: 1, ok: true, vector: [1, 2] }))).toEqual({
      id: 1,
      ok: true,
      vector: [1, 2],
    });
    expect(parseWorkerResponse(JSON.stringify({ id: 2, ok: false, error: "boom" }))).toEqual({
      id: 2,
      ok: false,
      error: "boom",
    });
  });
});

describe("EmbeddingSubprocessClient with fake worker", () => {
  it("warms up, embeds, and SIGKILLs on dispose", async () => {
    const runtime = resolveEmbeddingWorkerRuntime();
    if (!runtime) return;

    const client = new EmbeddingSubprocessClient({
      runtimePath: runtime,
      scriptPath: join(import.meta.dir, "fixtures", "embedding-worker-fake.mjs"),
    });

    await client.warmup({
      model: "fake",
      cacheDir: "/tmp",
      pooling: "mean",
    });
    const vector = await client.embed("abcd", "mean");
    expect(Array.from(vector)).toEqual([4, 5, 6]);

    const child = (client as unknown as { child: { killed: boolean; exitCode: number | null } })
      .child;
    client.dispose("test");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(child.killed || child.exitCode !== null).toBe(true);
  });
});
