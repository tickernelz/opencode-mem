//
// Drives the REAL normal memory path — memoryClient.addMemory /
// searchMemories / listMemories — in an isolated Bun child process against a
// real temp storage tree, while another process (the profile-learning winner)
// provably holds the profile-learning coordination lock.
//
// Mocked: only the external embedding service (fixed small vectors — no model
// download, no paid API). NOT mocked: memoryClient, ensureTursoReady, the
// turso shard/connection managers, scope write locks, or the SQLite writes
// themselves — so this exercises the real gate the deployment cares about,
// including the .turso-operation.lock path.
//
// Plain JavaScript on purpose: executed by `bun <file>.mjs`, not imported by
// the test runner.
//
import { mock } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const cfgPath = process.argv[2];
if (!cfgPath) {
  console.error("usage: bun profile-learning-memory-writer.mjs <config.json>");
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));

const DIM = cfg.embeddingDim ?? 8;

/** Fixed pseudo-random unit vector per text — deterministic, no model. */
function fixedVector(text) {
  const v = new Array(DIM);
  let h = 2166136261;
  for (const c of text) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  for (let i = 0; i < DIM; i++) {
    h ^= h << 13;
    h ^= h >>> 7;
    h ^= h << 17;
    v[i] = (((h >>> 0) % 2000) - 1000) / 1000;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return new Float32Array(v.map((x) => x / norm));
}

// Only the external embedding boundary is mocked. The service object shape
// mirrors src/memory/embedding.ts so client.ts keeps using its real logic.
mock.module(new URL("../../src/memory/embedding.js", import.meta.url).href, () => ({
  embeddingService: {
    embedWithTimeout: async (text) => fixedVector(text ?? ""),
    warmup: async () => {},
    isWarmedUp: true,
    initError: null,
  },
}));

const configUrl = new URL("../../src/config.js", import.meta.url).href;
mock.module(configUrl, () => ({
  CONFIG: {
    storagePath: cfg.storagePath,
    maxMemories: 100,
    similarityThreshold: 0.0,
    memoryDbShardSize: 1000,
    // Must match the fixed vectors above so the real shard schema accepts them.
    embeddingDimensions: DIM,
    embeddingModel: "mock-fixed-vector",
    maxVectorsPerShard: 1000,
  },
  initConfig: () => {},
  isConfigured: () => true,
}));

const loggerUrl = new URL("../../src/infra/logger.js", import.meta.url).href;
mock.module(loggerUrl, () => ({ log: () => {} }));

const counts = { add: 0, readback: 0, search: 0, list: 0 };
let addedId = null;

async function waitFile(path, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !existsSync(path)) {
    await sleep(20);
  }
  if (!existsSync(path)) throw new Error(`writer: handshake file never appeared: ${path}`);
}

try {
  const { memoryClient } = await import(
    new URL("../../src/memory/client.js", import.meta.url).href
  );

  // Block until the parent confirms the winner is provably holding the
  // profile-learning lock, so the write below happens strictly inside the
  // holding window — no sleep-based inference.
  if (cfg.holdingFile) await waitFile(cfg.holdingFile);

  const content = `ordinary memory ${cfg.marker ?? "writer"} ${Date.now()}`;
  // Real format: {prefix}_{user|project}_{16hex} — validated by the real path.
  const containerTag = `opencode_project_${cfg.projectHash ?? "0123456789abcdef"}`;

  const add = await memoryClient.addMemory(content, containerTag, {
    type: "preference",
    source: "manual",
    tags: ["service-lock-test"],
    projectPath: cfg.projectPath ?? "/workspace",
  });
  if (add?.success) counts.add += 1;
  addedId = add?.id ?? null;
  // Read-back via the real search path (real SQLite read + vector search).
  const search = await memoryClient.searchMemories(content, containerTag, "project");
  if (search?.success) counts.search += 1;
  if (search?.success && search.results?.some((r) => r.id === addedId)) counts.readback += 1;

  const list = await memoryClient.listMemories(containerTag, 50, "project");
  if (list?.success && list.memories?.some((m) => m.id === addedId)) counts.list += 1;

  console.log(
    JSON.stringify({
      ok: true,
      holdingObserved: Boolean(cfg.holdingFile),
      addedId,
      addError: add?.success ? undefined : (add?.error ?? "no id"),
      counts,
      searchTotal: search?.total ?? null,
    })
  );
} catch (e) {
  console.log(JSON.stringify({ fatal: e?.message ?? String(e), counts }));
  process.exit(1);
}
process.exit(0);
