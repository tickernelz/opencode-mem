import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

describe("plugin Turso refcount (#443)", () => {
  let baseDir: string;

  afterEach(async () => {
    const { resetPluginTursoRefsForTests } = await import("../src/services/turso/lifecycle.js");
    resetPluginTursoRefsForTests();
    await cleanupTursoTestDirectory(baseDir);
  });

  it("releasePluginTurso keeps the pool open while another instance is alive", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-refcount-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;

    const {
      retainPluginTurso,
      releasePluginTurso,
      pluginTursoRefCount,
      resetPluginTursoRefsForTests,
      closeTursoAndInvalidateCaches,
    } = await import("../src/services/turso/lifecycle.js");
    const { userPromptManager } =
      await import("../src/services/user-prompt/user-prompt-manager.js");
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");

    await closeTursoAndInvalidateCaches();
    resetPluginTursoRefsForTests();

    retainPluginTurso();
    retainPluginTurso();
    expect(pluginTursoRefCount()).toBe(2);

    const id = await userPromptManager.savePrompt("sess-a", "msg-a", "/tmp/p", "hello");
    const dbPath = join(baseDir, "user-prompts.db");
    const handleBefore = await tursoConnectionManager.getConnection(dbPath);

    const closedOnFirstRelease = await releasePluginTurso();
    expect(closedOnFirstRelease).toBe(false);
    expect(pluginTursoRefCount()).toBe(1);

    // Sibling instance still live: same pooled handle, queries still work.
    expect(await tursoConnectionManager.getConnection(dbPath)).toBe(handleBefore);
    const prompt = await userPromptManager.getPromptById(id);
    expect(prompt?.content).toBe("hello");

    const closedOnLastRelease = await releasePluginTurso();
    expect(closedOnLastRelease).toBe(true);
    expect(pluginTursoRefCount()).toBe(0);
  });

  it("memoryClient.close only invalidates when the last lease is released", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-refcount-client-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;

    const {
      retainPluginTurso,
      pluginTursoRefCount,
      resetPluginTursoRefsForTests,
      closeTursoAndInvalidateCaches,
    } = await import("../src/services/turso/lifecycle.js");
    const { memoryClient } = await import("../src/services/client.js");
    const { userPromptManager } =
      await import("../src/services/user-prompt/user-prompt-manager.js");

    await closeTursoAndInvalidateCaches();
    resetPluginTursoRefsForTests();

    retainPluginTurso();
    retainPluginTurso();
    expect(pluginTursoRefCount()).toBe(2);

    const id = await userPromptManager.savePrompt("sess-b", "msg-b", "/tmp/p", "world");

    // Fake a warmed local model so the close path has something to release.
    const { embeddingService } = await import("../src/services/embedding.js");
    const released: string[] = [];
    Object.assign(embeddingService, {
      pipe: { dispose: async () => released.push("dispose") },
      isWarmedUp: true,
    });

    await memoryClient.close();
    expect(pluginTursoRefCount()).toBe(1);
    expect((await userPromptManager.getPromptById(id))?.content).toBe("world");
    // Sibling instance still live: the process-wide model must stay loaded.
    expect(released).toEqual([]);

    await memoryClient.close();
    expect(pluginTursoRefCount()).toBe(0);
    expect(released).toEqual(["dispose"]);
  });
});
