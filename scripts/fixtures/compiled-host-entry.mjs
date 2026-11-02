#!/usr/bin/env bun
/**
 * Minimal OpenCode-shaped Bun host entry for #210 / #225.
 *
 * OpenCode is shipped via Bun.build({ compile: { autoloadPackageJson: true, ... }})
 * and dynamically imports external plugins. This entry mimics that load path,
 * runs a real local embedding, and exits normally so Bun 1.3.14 + onnxruntime
 * teardown regressions (#225) are caught by the parent fixture.
 *
 * Env:
 *   OPENCODE_MEM_PLUGIN_ENTRY — absolute file URL or path to embedding.js
 *   OPENCODE_MEM_EMBEDDING_MODEL — optional feature-extraction model id
 *   OPENCODE_MEM_EMBEDDING_DIMS — expected trailing embedding dimension
 */
const PINNED = "1.31.1";
const MODEL = process.env.OPENCODE_MEM_EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2";
const EXPECTED_DIMS = Number(process.env.OPENCODE_MEM_EMBEDDING_DIMS || "384");

const entry = process.env.OPENCODE_MEM_PLUGIN_ENTRY;
if (!entry) {
  console.error("OPENCODE_MEM_PLUGIN_ENTRY is required");
  process.exit(1);
}

const mod = await import(entry);
if (typeof mod.loadLocalTransformersBackend !== "function") {
  console.error("plugin entry does not export loadLocalTransformersBackend");
  process.exit(1);
}

const transformers = await mod.loadLocalTransformersBackend();
if (typeof transformers.pipeline !== "function" || !transformers.env) {
  console.error("loadLocalTransformersBackend did not expose pipeline/env");
  process.exit(1);
}

const { createRequire } = await import("node:module");
const { dirname, join } = await import("node:path");
const { existsSync, readFileSync } = await import("node:fs");
const { fileURLToPath, pathToFileURL } = await import("node:url");

const entryPath = entry.startsWith("file:") ? fileURLToPath(entry) : entry;
const pluginRequire = createRequire(entryPath);
const resolveUrl = pathToFileURL(join(dirname(entryPath), "onnxruntime-resolve.js")).href;
const { getPinnedOnnxruntimePackageRoot, prepareOnnxruntimeForTransformers } = await import(
  resolveUrl
);
prepareOnnxruntimeForTransformers();

function pkgVersion(entryFile) {
  let dir = dirname(entryFile);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, "utf8"));
      if (typeof parsed.version === "string" && parsed.version.length > 0) {
        return parsed.version;
      }
    }
    dir = dirname(dir);
  }
  throw new Error(`versioned package.json not found near ${entryFile}`);
}

const nodeEntry = pluginRequire.resolve("onnxruntime-node");
const commonEntry = createRequire(nodeEntry).resolve("onnxruntime-common");
const nodeVersion = pkgVersion(nodeEntry);
const commonVersion = pkgVersion(commonEntry);
const pinnedRoot = getPinnedOnnxruntimePackageRoot();

if (nodeVersion !== PINNED) {
  console.error(`expected onnxruntime-node@${PINNED}, got ${nodeVersion} at ${nodeEntry}`);
  process.exit(1);
}
if (commonVersion !== PINNED) {
  console.error(`expected onnxruntime-common@${PINNED}, got ${commonVersion} at ${commonEntry}`);
  process.exit(1);
}

transformers.env.allowLocalModels = true;
transformers.env.allowRemoteModels = true;
try {
  transformers.env.backends.onnx.wasm.numThreads = 1;
} catch {
  /* wasm backend optional */
}

const extractor = await transformers.pipeline("feature-extraction", MODEL);
const out = await extractor("compiled-host onnx shutdown regression", {
  pooling: "mean",
  normalize: true,
});
const dims = out.dims?.[out.dims.length - 1];
if (dims !== EXPECTED_DIMS) {
  console.error(`expected ${EXPECTED_DIMS} dims, got ${dims}`);
  process.exit(1);
}
const vec = Array.from(out.data);
const allFinite = vec.every((x) => Number.isFinite(x));
const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
if (!allFinite || !(norm > 0.9 && norm < 1.1)) {
  console.error(`bad embedding vector (finite=${allFinite}, norm=${norm})`);
  process.exit(1);
}

console.log(
  JSON.stringify({
    ok: true,
    nodeEntry,
    commonEntry,
    nodeVersion,
    commonVersion,
    pinnedRoot,
    model: MODEL,
    embeddingDims: dims,
    embeddingNorm: Number(norm.toFixed(4)),
  })
);

// Let the process exit naturally. Bun 1.3.14 + onnxruntime-node@1.21.0–1.23.2
// crashed during Ort::Env teardown after successful inference (#225). Exit code
// 0 is asserted by the parent fixture via spawnSync status/signal.
