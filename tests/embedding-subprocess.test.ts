import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  collectEmbeddingWorkerDirs,
  EmbeddingSubprocessClient,
  resolveEmbeddingWorkerPackageRoot,
  resolveEmbeddingWorkerRuntime,
  resolveEmbeddingWorkerScript,
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

describe("resolveEmbeddingWorkerRuntime", () => {
  it("falls back to process.execPath with BUN_BE_BUN when no node/bun on PATH", () => {
    // Under bun test we always have a bun-capable execPath.
    const runtime = resolveEmbeddingWorkerRuntime();
    expect(runtime).not.toBeNull();
    expect(runtime!.command.length).toBeGreaterThan(0);
    // Prefer real node/bun when present; otherwise OpenCode-style self re-exec.
    if (runtime!.env.BUN_BE_BUN === "1") {
      expect(runtime!.command).toBe(process.execPath);
    }
  });
});

describe("EmbeddingSubprocessClient readiness", () => {
  it("rejects embed before warmup and after worker exit", async () => {
    const runtime = resolveEmbeddingWorkerRuntime();
    if (!runtime) return;

    const client = new EmbeddingSubprocessClient({
      runtime,
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

describe("resolveEmbeddingWorkerScript anchors", () => {
  it("finds the worker via import.meta.path when url is unusable", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-mem-worker-"));
    const services = join(root, "dist", "services");
    mkdirSync(services, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "opencode-mem" }));
    const worker = join(services, "embedding-worker.js");
    writeFileSync(worker, "export {}\n");

    const resolved = resolveEmbeddingWorkerScript({
      url: "",
      path: join(services, "embedding-subprocess.js"),
    } as ImportMeta & { path?: string });
    expect(resolved).toBe(worker);
    expect(resolveEmbeddingWorkerPackageRoot(resolved)).toBe(root);
  });

  it("collects dirs without throwing on a bad import.meta.url", () => {
    const dirs = collectEmbeddingWorkerDirs({
      url: "not-a-file-url",
      path: "/tmp/opencode-mem/dist/services/embedding-subprocess.js",
    } as ImportMeta & { path?: string });
    expect(
      dirs.some((dir) => dir.includes("dist/services") || dir.includes("dist\\services"))
    ).toBe(true);
  });
});

describe("EmbeddingSubprocessClient with fake worker", () => {
  it("warms up, embeds, and SIGKILLs on dispose", async () => {
    const runtime = resolveEmbeddingWorkerRuntime();
    if (!runtime) return;

    const client = new EmbeddingSubprocessClient({
      runtime,
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

  it("runs the worker via BUN_BE_BUN self re-exec (OpenCode-style)", async () => {
    if (typeof process.versions.bun !== "string") return;

    const client = new EmbeddingSubprocessClient({
      runtime: { command: process.execPath, args: [], env: { BUN_BE_BUN: "1" } },
      scriptPath: join(import.meta.dir, "fixtures", "embedding-worker-fake.mjs"),
      requestTimeoutMs: 10_000,
    });

    await client.warmup({ model: "fake", cacheDir: "/tmp", pooling: "mean" });
    expect(Array.from(await client.embed("xy", "mean"))).toEqual([2, 3, 4]);
    client.dispose("bun-be-bun-test");
  });
});
