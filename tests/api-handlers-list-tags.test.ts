import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

describe("handleListTags scope coverage", () => {
  let baseDir: string;

  afterEach(async () => {
    await cleanupTursoTestDirectory(baseDir);
  });

  it("returns user-scope tags alongside project tags", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-list-tags-"));

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 768;

    const { closeTursoAndInvalidateCaches } = await import("../src/storage/turso/lifecycle.js");
    await closeTursoAndInvalidateCaches();

    const { tursoShardManager } = await import("../src/storage/turso/shard-manager.js");
    const { tursoConnectionManager } = await import("../src/storage/turso/connection-manager.js");
    const { tursoVectorSearch } = await import("../src/storage/turso/vector-search.js");
    const { handleListTags } = await import("../src/runtime/http/api-handlers.js");

    const vector = new Float32Array(768);
    vector[0] = 1;

    const userHash = "aaaaaaaaaaaaaaaa";
    const projectHash = "bbbbbbbbbbbbbbbb";
    const userTag = `opencode_user_${userHash}`;
    const projectTag = `opencode_project_${projectHash}`;

    const userShard = await tursoShardManager.createShard("user", userHash, 0);
    const userDb = await tursoConnectionManager.getConnection(userShard.dbPath);
    await tursoVectorSearch.insertVector(userDb, {
      id: "mem_user_1",
      content: "user scoped memory",
      vector,
      containerTag: userTag,
      displayName: "Ada",
      userName: "Ada",
      userEmail: "ada@example.com",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const projectShard = await tursoShardManager.createShard("project", projectHash, 0);
    const projectDb = await tursoConnectionManager.getConnection(projectShard.dbPath);
    await tursoVectorSearch.insertVector(projectDb, {
      id: "mem_project_1",
      content: "project scoped memory",
      vector,
      containerTag: projectTag,
      displayName: "demo-app",
      projectPath: "/tmp/demo-app",
      projectName: "demo-app",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const result = await handleListTags();
    expect(result.success).toBe(true);
    expect(result.data?.project.map((t) => t.tag)).toEqual([projectTag]);
    expect(result.data?.user.map((t) => t.tag)).toEqual([userTag]);
    expect(result.data?.user[0]?.displayName).toBe("Ada");
    expect(result.data?.project[0]?.displayName).toBe("demo-app");
  });
});
