import assert from "node:assert/strict";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { spyOn } from "bun:test";

const [scenario, home] = process.argv.slice(2);
const vault = join(home!, "vault");
const { CONFIG } = await import("../../src/config.js");
Object.assign(CONFIG, {
  storagePath: join(home!, "storage"),
  markdownPath: vault,
  memoryBackend: "markdown",
  embeddingDimensions: 2,
});
const { embeddingService } = await import("../../src/services/embedding.js");
embeddingService.warmup = async () => {};
embeddingService.embedWithTimeout = async () => new Float32Array([1, 0]);
const { reconcileMarkdownVault, reindexVaultFile } =
  await import("../../src/services/markdown/reconcile.js");
const { tursoShardManager } = await import("../../src/services/turso/shard-manager.js");
const { tursoConnectionManager } = await import("../../src/services/turso/connection-manager.js");
const { tursoVectorSearch } = await import("../../src/services/turso/vector-search.js");
const { startMarkdownBackend, stopMarkdownBackend } =
  await import("../../src/services/markdown/backend.js");
const { getUserTagInfo } = await import("../../src/services/tags.js");
const tag = getUserTagInfo().tag;

function note(path: string, id: string, body = `Content for ${id}`) {
  fs.mkdirSync(dirname(join(vault, path)), { recursive: true });
  fs.writeFileSync(join(vault, path), `---\nid: "${id}"\ncontainerTag: "${tag}"\n---\n\n${body}\n`);
}
async function snapshot() {
  const shards = await tursoShardManager.getAllShards("user", "");
  const rows = [];
  for (const shard of shards) {
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    rows.push(
      ...(await db.all("SELECT id, content, metadata, deleted_at FROM memories ORDER BY id"))
    );
  }
  return { rows, counts: shards.map((s) => s.vectorCount) };
}
async function ids() {
  return (await snapshot()).rows
    .filter((r) => r.deleted_at === null)
    .map((r) => r.id)
    .sort();
}
let restore: (() => void) | undefined;
try {
  fs.mkdirSync(vault, { recursive: true });
  if (scenario === "fresh-empty") {
    const result = await reconcileMarkdownVault();
    assert.equal(result.deleted, 0);
    assert.equal(result.deletionSkipped, undefined);
    assert.deepEqual(result.errors, []);
  } else {
    note("a.md", "a");
    note("nested/b.md", "b");
    note("c.md", "c");
    assert.equal((await reconcileMarkdownVault()).upserted, 3);
    // Preserve unrelated metadata and a trashed row too, not just live IDs.
    const shard = (await tursoShardManager.getAllShards("user", ""))[0]!;
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    await tursoVectorSearch.patchMemoryMetadata(db, "a", { custom: "keep-me" });
    await tursoVectorSearch.insertVector(db, {
      id: "trashed",
      content: "Trash",
      vector: new Float32Array([1, 0]),
      containerTag: tag,
      createdAt: 1,
      updatedAt: 1,
      metadata: '{"custom":"trash-metadata"}',
    });
    await tursoShardManager.incrementVectorCount(shard.id);
    await tursoVectorSearch.softDeleteVector(db, "trashed");
    if (scenario === "incremental-delete") {
      await tursoVectorSearch.insertVector(db, {
        id: "unrelated",
        content: "Database-only memory",
        vector: new Float32Array([1, 0]),
        containerTag: tag,
        createdAt: 1,
        updatedAt: 1,
        metadata: '{"custom":"unrelated-metadata"}',
      });
      await tursoShardManager.incrementVectorCount(shard.id);
    }
    const before = await snapshot();
    let reason: "empty-vault" | "incomplete-scan" = "incomplete-scan";
    let errorPath = ".";
    let readableAddition = false;
    if (
      ["missing-root", "startup-missing-root", "incremental-missing", "restored-vault"].includes(
        scenario!
      )
    ) {
      fs.renameSync(vault, `${vault}-saved`);
      if (scenario === "startup-missing-root") reason = "empty-vault";
    } else if (["empty-root", "incremental-empty", "no-markdown-files"].includes(scenario!)) {
      fs.rmSync(vault, { recursive: true });
      fs.mkdirSync(vault);
      reason = "empty-vault";
      if (scenario === "no-markdown-files") {
        fs.writeFileSync(join(vault, "readme.txt"), "Not a Markdown note");
        note(".obsidian/ignored.md", "ignored-obsidian");
        note(".trash/ignored.md", "ignored-trash");
      }
    } else if (scenario === "root-is-file") {
      fs.rmSync(vault, { recursive: true });
      fs.writeFileSync(vault, "not a directory");
    } else if (
      ["unreadable-root", "partial-directory", "incremental-partial"].includes(scenario!)
    ) {
      const target = scenario === "unreadable-root" ? vault : join(vault, "nested");
      errorPath = scenario === "unreadable-root" ? "." : "nested";
      if (scenario !== "unreadable-root") {
        note("new.md", "new");
        readableAddition = true;
      }
      const original = fs.readdirSync;
      const spy = spyOn(fs, "readdirSync").mockImplementation(((
        ...args: Parameters<typeof original>
      ) => {
        if (String(args[0]) === target) throw new Error("injected EACCES");
        return original(...args);
      }) as typeof original);
      restore = () => spy.mockRestore();
    } else if (["failed-stat", "failed-read"].includes(scenario!)) {
      errorPath = "nested/b.md";
      note("new.md", "new");
      readableAddition = true;
      const method = scenario === "failed-stat" ? "statSync" : "readFileSync";
      const original = fs[method];
      const spy = spyOn(fs, method).mockImplementation(((...args: unknown[]) => {
        if (String(args[0]) === join(vault, errorPath)) throw new Error("injected EIO");
        return Reflect.apply(original, fs, args);
      }) as typeof original);
      restore = () => spy.mockRestore();
    } else if (["failed-upsert", "empty-note"].includes(scenario!)) {
      fs.unlinkSync(join(vault, "c.md"));
      errorPath = "new.md";
      if (scenario === "empty-note") fs.writeFileSync(join(vault, errorPath), "");
      else {
        note("new.md", "new");
        const original = tursoVectorSearch.insertVector.bind(tursoVectorSearch);
        const spy = spyOn(tursoVectorSearch, "insertVector").mockImplementation(
          async (db, record) => {
            if (record.id === "new") throw new Error("injected insert failure");
            return original(db, record);
          }
        );
        restore = () => spy.mockRestore();
      }
    } else if (["healthy-majority-delete", "incremental-delete"].includes(scenario!)) {
      fs.unlinkSync(join(vault, "a.md"));
      fs.unlinkSync(join(vault, "nested/b.md"));
    } else if (scenario === "incremental-rename") {
      fs.renameSync(join(vault, "a.md"), join(vault, "renamed.md"));
    } else if (scenario === "single-read") {
      const original = fs.readFileSync;
      let reads = 0;
      const spy = spyOn(fs, "readFileSync").mockImplementation(((
        ...args: Parameters<typeof original>
      ) => {
        if (String(args[0]) === join(vault, "a.md")) {
          reads++;
          if (reads > 1) return '---\nid: "different-id"\n---\nChanged during read';
        }
        return original(...args);
      }) as typeof original);
      restore = () => {
        spy.mockRestore();
        assert.equal(reads, 1, "full reconcile must read each file once");
      };
    }

    if (scenario!.startsWith("incremental-")) {
      await reindexVaultFile(scenario === "incremental-partial" ? "nested/b.md" : "a.md");
    } else {
      const result =
        scenario === "startup-missing-root"
          ? await startMarkdownBackend()
          : await reconcileMarkdownVault();
      assert.ok(result);
      if (!["healthy-majority-delete", "single-read"].includes(scenario!)) {
        assert.equal(result.deleted, 0, "unsafe scan must not delete any indexed memory");
        assert.equal(result.deletionSkipped, reason);
        if (reason === "incomplete-scan")
          assert.ok(result.errors.some((e) => e.path === errorPath));
        if (readableAddition) assert.equal(result.upserted, 1);
      } else if (scenario === "healthy-majority-delete") assert.equal(result.deleted, 2);
    }
    restore?.();
    restore = undefined;
    if (
      ![
        "healthy-majority-delete",
        "incremental-delete",
        "incremental-rename",
        "single-read",
      ].includes(scenario!)
    ) {
      const warning = fs
        .readFileSync(join(home!, "test.log"), "utf-8")
        .split("\n")
        .find((line) =>
          line.includes("markdown reconcile warning: deletion skipped; existing index retained")
        );
      assert.ok(warning, "skipped deletion must emit a warning");
      assert.ok(warning.includes(JSON.stringify(reason)), "warning must identify the skip reason");
    }
    if (scenario === "incremental-delete") {
      assert.deepEqual(await ids(), ["b", "c", "unrelated"]);
      assert.deepEqual((await snapshot()).counts, [4]);
      await reindexVaultFile("nested/b.md");
      assert.deepEqual(await ids(), ["c", "unrelated"]);
      const after = await snapshot();
      assert.deepEqual(after.counts, [3]);
      assert.deepEqual(
        after.rows.find((r) => r.id === "unrelated"),
        before.rows.find((r) => r.id === "unrelated")
      );
    } else if (scenario === "healthy-majority-delete") {
      assert.deepEqual(await ids(), ["c"]);
      assert.deepEqual((await snapshot()).counts, [2]);
    } else if (scenario === "incremental-rename") {
      assert.deepEqual(await ids(), ["a", "b", "c"]);
      const row = (await snapshot()).rows.find((r) => r.id === "a")!;
      assert.equal(JSON.parse(String(row.metadata)).markdownRelPath, "renamed.md");
    } else if (readableAddition) {
      const after = await snapshot();
      assert.deepEqual(
        after.rows.filter((r) => r.id !== "new"),
        before.rows
      );
      assert.deepEqual(after.counts, [5]);
    } else
      assert.deepEqual(
        await snapshot(),
        before,
        "rows, metadata, trash and shard counts must be preserved"
      );
    if (scenario === "restored-vault") {
      fs.renameSync(`${vault}-saved`, vault);
      fs.unlinkSync(join(vault, "a.md"));
      note("new.md", "new");
      const result = await reconcileMarkdownVault();
      assert.equal(result.deletionSkipped, undefined);
      assert.equal(result.deleted, 1);
      assert.equal(result.upserted, 1);
      assert.deepEqual(await ids(), ["b", "c", "new"]);
    }
    const trash = (await snapshot()).rows.find((r) => r.id === "trashed");
    assert.deepEqual(
      trash,
      before.rows.find((r) => r.id === "trashed")
    );
  }
} finally {
  restore?.();
  stopMarkdownBackend();
  await tursoConnectionManager.closeAll();
}
