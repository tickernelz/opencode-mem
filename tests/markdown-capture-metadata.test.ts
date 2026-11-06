import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = (path: string) => JSON.stringify(new URL(`../src/${path}`, import.meta.url).href);

// Isolate real client/DB integration from the suite's process-wide module mocks.
function scenario(body: string): void {
  const baseDir = mkdtempSync(join(tmpdir(), "markdown-capture-metadata-"));
  try {
    const script = join(baseDir, "scenario.mjs");
    writeFileSync(
      script,
      `
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const baseDir = ${JSON.stringify(baseDir)};
const { CONFIG } = await import(${source("config.js")});
CONFIG.storagePath = join(baseDir, "storage");
CONFIG.embeddingDimensions = 2;
CONFIG.containerTagPrefix = "opencode";
CONFIG.memoryBackend = "markdown";
CONFIG.markdownPath = join(baseDir, "vault");
const { embeddingService } = await import(${source("services/embedding.js")});
embeddingService.warmup = async () => {};
embeddingService.clearCache = () => {};
embeddingService.embedWithTimeout = async () => new Float32Array([1, 0]);
const { memoryClient } = await import(${source("services/client.js")});
const { tursoConnectionManager } = await import(${source("services/turso/connection-manager.js")});
const { tursoShardManager } = await import(${source("services/turso/shard-manager.js")});
const { tursoVectorSearch } = await import(${source("services/turso/vector-search.js")});
const { closeTursoAndInvalidateCaches } = await import(${source("services/turso/lifecycle.js")});
const { reconcileMarkdownVault, reindexVaultFile } = await import(${source("services/markdown/reconcile.js")});
const { parseMemoryMarkdown } = await import(${source("services/markdown/document.js")});
const { applyUpdateOnCaptureDecision } = await import(${source("services/update-on-capture.js")});
const tag = "opencode_project_abcdef1234567890";
const initialCapture = { promptId: "prompt_initial", sessionID: "session_initial", captureTimestamp: 1234 };
const auxiliary = {
  userName: "Synthetic User", userEmail: "synthetic@example.invalid", projectPath: "/synthetic/project",
  projectName: "Synthetic Project", gitRepoUrl: "https://example.invalid/project.git"
};
async function addCapture() {
  const added = await memoryClient.addMemory("Initial captured fact", tag, {
    source: "auto-capture", type: "fact", ...initialCapture, ...auxiliary,
    customProvenance: { importedFrom: "synthetic" }, updatedByCapture: true
  });
  assert.equal(added.success, true, JSON.stringify(added));
  return added.id;
}
async function indexed(id) {
  const shards = await tursoShardManager.getAllShards("project", "");
  for (const shard of shards) {
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    const row = await tursoVectorSearch.getMemoryById(db, id);
    if (row) return { row, db, metadata: JSON.parse(String(row.metadata)) };
  }
  throw new Error("Missing indexed memory: " + id);
}
function filePath(id) { return join(CONFIG.markdownPath, id + ".md"); }
function assertCapture(value, capture) {
  for (const [key, expected] of Object.entries(capture)) assert.equal(value[key], expected, key);
}
function assertAuxiliary(row) {
  assert.equal(row.user_name, auxiliary.userName);
  assert.equal(row.user_email, auxiliary.userEmail);
  assert.equal(row.project_path, auxiliary.projectPath);
  assert.equal(row.project_name, auxiliary.projectName);
  assert.equal(row.git_repo_url, auxiliary.gitRepoUrl);
  assert.equal(Number(row.is_pinned), 1);
  assert.equal(row.deleted_at, null);
}
try {
  ${body}
} finally {
  await closeTursoAndInvalidateCaches();
}
`
    );
    const result = Bun.spawnSync({
      cmd: [process.execPath, script],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });
    expect(result.exitCode, Buffer.from(result.stderr).toString()).toBe(0);
  } finally {
    rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

describe("markdown capture metadata", () => {
  it("preserves capture provenance and index-only state through writes and reconciliation", () => {
    scenario(String.raw`
const id = await addCapture();
let file = parseMemoryMarkdown(readFileSync(filePath(id), "utf8"));
assertCapture(file.frontmatter, initialCapture);
assert.equal(file.frontmatter.customProvenance, undefined);
let current = await indexed(id);
await tursoVectorSearch.pinMemory(current.db, id);
const first = await reconcileMarkdownVault();
assert.equal(first.upserted, 1);
assert.deepEqual(first.errors, []);
current = await indexed(id);
assertCapture(current.metadata, initialCapture);
assert.equal(current.row.session_id, initialCapture.sessionID);
assert.deepEqual(current.metadata.customProvenance, { importedFrom: "synthetic" });
assert.equal(current.metadata.updatedByCapture, true);
assertAuxiliary(current.row);
const repeated = await reconcileMarkdownVault();
assert.equal(repeated.unchanged, 1);
assert.equal(repeated.upserted, 0);
assert.deepEqual(repeated.errors, []);
writeFileSync(filePath(id), readFileSync(filePath(id), "utf8").replace("Initial captured fact", "Edited in the vault"));
await reindexVaultFile(id + ".md");
current = await indexed(id);
assert.equal(current.row.content, "Edited in the vault");
assertCapture(current.metadata, initialCapture);
assertAuxiliary(current.row);
const updatedCapture = { promptId: "prompt_updated", sessionID: "session_updated", captureTimestamp: 0 };
// Use the actual update-on-capture path; pinned memories are intentionally excluded.
await tursoVectorSearch.unpinMemory(current.db, id);
const updated = await applyUpdateOnCaptureDecision(memoryClient, { action: "update", targetId: id, content: "Updated captured fact" }, {
  summary: "Updated captured fact", type: "fact", tags: [], containerTag: tag,
  metadata: { source: "auto-capture", type: "fact", tags: [], ...updatedCapture }
}, new Set([id]));
assert.equal(updated.success, true, JSON.stringify(updated));
assert.equal(updated.action, "update");
file = parseMemoryMarkdown(readFileSync(filePath(id), "utf8"));
assertCapture(file.frontmatter, updatedCapture);
current = await indexed(id);
assert.equal(current.row.session_id, updatedCapture.sessionID);
assertCapture(current.metadata, updatedCapture);
await tursoVectorSearch.pinMemory(current.db, id);
const afterUpdate = await reconcileMarkdownVault();
assert.equal(afterUpdate.upserted, 1);
assert.deepEqual(afterUpdate.errors, []);
current = await indexed(id);
assert.equal(current.row.content, "Updated captured fact");
assert.equal(current.row.session_id, updatedCapture.sessionID);
assertCapture(current.metadata, updatedCapture);
assert.deepEqual(current.metadata.customProvenance, { importedFrom: "synthetic" });
assertAuxiliary(current.row);
`);
  });

  it("retains legacy metadata when capture fields are absent or invalid, and accepts valid file edits", () => {
    scenario(String.raw`
const id = await addCapture();
const legacy = readFileSync(filePath(id), "utf8").split("\n").filter(line => !/^(promptId|sessionID|captureTimestamp):/.test(line)).join("\n");
writeFileSync(filePath(id), legacy);
let result = await reconcileMarkdownVault();
assert.deepEqual(result.errors, []);
let current = await indexed(id);
assertCapture(current.metadata, initialCapture);
assert.equal(current.row.session_id, initialCapture.sessionID);
assert.deepEqual(current.metadata.customProvenance, { importedFrom: "synthetic" });
writeFileSync(filePath(id), legacy.replace("---\n", "---\npromptId: 123\nsessionID: false\ncaptureTimestamp: -1\n"));
await reindexVaultFile(id + ".md");
current = await indexed(id);
assertCapture(current.metadata, initialCapture);
assert.equal(current.row.session_id, initialCapture.sessionID);
writeFileSync(filePath(id), legacy.replace("---\n", '---\npromptId: "prompt_from_file"\nsessionID: "session_from_file"\ncaptureTimestamp: 5678\n'));
await reindexVaultFile(id + ".md");
current = await indexed(id);
assertCapture(current.metadata, { promptId: "prompt_from_file", sessionID: "session_from_file", captureTimestamp: 5678 });
assert.equal(current.row.session_id, "session_from_file");
assert.deepEqual(current.metadata.customProvenance, { importedFrom: "synthetic" });
`);
  });

  it("rebuilds capture provenance and the indexed session from the vault into an empty database", () => {
    scenario(String.raw`
const id = await addCapture();
await closeTursoAndInvalidateCaches();
CONFIG.storagePath = join(baseDir, "rebuilt-storage");
memoryClient.reset();
const result = await reconcileMarkdownVault();
assert.equal(result.upserted, 1);
assert.deepEqual(result.errors, []);
const current = await indexed(id);
assertCapture(current.metadata, initialCapture);
assert.equal(current.row.session_id, initialCapture.sessionID);
assert.equal(current.metadata.source, "auto-capture");
assert.equal(current.metadata.customProvenance, undefined);
assert.equal(current.row.content, "Initial captured fact");
const sameSession = await tursoVectorSearch.getMemoriesBySessionID(current.db, initialCapture.sessionID);
assert.deepEqual(sameSession.map(memory => memory.id), [id]);
`);
  });

  it("retains the indexed session when a legacy row has no metadata session field", () => {
    scenario(String.raw`
const id = await addCapture();
const legacy = readFileSync(filePath(id), "utf8").split("\n").filter(line => !/^(promptId|sessionID|captureTimestamp):/.test(line)).join("\n");
writeFileSync(filePath(id), legacy);
let current = await indexed(id);
await current.db.run("UPDATE memories SET metadata = ? WHERE id = ?", [JSON.stringify({ custom: "kept" }), id]);
const result = await reconcileMarkdownVault();
assert.deepEqual(result.errors, []);
current = await indexed(id);
assert.equal(current.row.session_id, initialCapture.sessionID);
assert.equal(current.metadata.custom, "kept");
assert.equal(current.metadata.promptId, undefined);
`);
  });
  it("moves a memory between project shards without losing provenance, pin state, or counts", () => {
    scenario(String.raw`
const id = await addCapture();
const initial = await reconcileMarkdownVault();
assert.deepEqual(initial.errors, []);
const originalShards = await tursoShardManager.getAllShards("project", "abcdef1234567890");
assert.equal(originalShards.length, 1);
const originalShard = originalShards[0];
let current = await indexed(id);
await tursoVectorSearch.pinMemory(current.db, id);
const originalDb = current.db;
const destinationTag = "opencode_project_1234567890abcdef";
writeFileSync(filePath(id), readFileSync(filePath(id), "utf8").replace(
  'containerTag: "' + tag + '"', 'containerTag: "' + destinationTag + '"'
));
const moved = await reconcileMarkdownVault();
assert.equal(moved.upserted, 1);
assert.equal(moved.deleted, 0);
assert.deepEqual(moved.errors, []);
const destinationShards = await tursoShardManager.getAllShards("project", "1234567890abcdef");
assert.equal(destinationShards.length, 1);
const destinationShard = destinationShards[0];
assert.notEqual(destinationShard.id, originalShard.id);
assert.notEqual(destinationShard.dbPath, originalShard.dbPath);
assert.equal(destinationShard.scope, "project");
assert.equal(destinationShard.scopeHash, "1234567890abcdef");
assert.equal(await tursoVectorSearch.getMemoryById(originalDb, id, { includeDeleted: true }), null);
assert.equal(await tursoVectorSearch.countAllVectors(originalDb), 0);
assert.equal((await tursoShardManager.getShardById(originalShard.id)).vectorCount, 0);
const destinationDb = await tursoConnectionManager.getConnection(destinationShard.dbPath);
const destinationRow = await tursoVectorSearch.getMemoryById(destinationDb, id);
assert.equal(destinationRow.container_tag, destinationTag);
assert.equal(destinationRow.session_id, initialCapture.sessionID);
assertCapture(JSON.parse(destinationRow.metadata), initialCapture);
assert.deepEqual(JSON.parse(destinationRow.metadata).customProvenance, { importedFrom: "synthetic" });
assertAuxiliary(destinationRow);
assert.equal(await tursoVectorSearch.countAllVectors(destinationDb), 1);
assert.equal((await tursoShardManager.getShardById(destinationShard.id)).vectorCount, 1);
const repeated = await reconcileMarkdownVault();
assert.equal(repeated.unchanged, 1);
assert.deepEqual(repeated.errors, []);
assert.equal((await tursoShardManager.getShardById(originalShard.id)).vectorCount, 0);
assert.equal((await tursoShardManager.getShardById(destinationShard.id)).vectorCount, 1);
`);
  });

  it("reindexes malformed indexed metadata using valid capture fields from the file", () => {
    scenario(String.raw`
const id = await addCapture();
for (const malformed of ['{invalid JSON', 'null', '[{"promptId":"wrong"}]']) {
  const before = await indexed(id);
  await before.db.run("UPDATE memories SET metadata = ? WHERE id = ?", [malformed, id]);
  const result = await reconcileMarkdownVault();
  assert.equal(result.upserted, 1, malformed);
  assert.deepEqual(result.errors, [], malformed);
  const current = await indexed(id);
  assertCapture(current.metadata, initialCapture);
  assert.equal(current.row.session_id, initialCapture.sessionID);
  assert.equal(current.metadata.source, "auto-capture");
  assert.equal(current.metadata.markdownRelPath, id + ".md");
  assert.equal(current.metadata[0], undefined);
  assert.equal(await tursoVectorSearch.countAllVectors(current.db), 1);
}
`);
  });
});
