#!/usr/bin/env node
/**
 * Embedding-backend smoke test — verifies the local @huggingface/transformers
 * feature-extraction path loads and runs the native ONNX runtime without
 * crashing on the host platform.
 *
 * Mirrors the production loader: prefer the CJS export so OpenCode nested
 * installs can pin onnxruntime-node@1.31.1 via Module._resolveFilename (#210 / #225).
 * This script deliberately does not import prepareOnnxruntimeForTransformers()
 * because the embedding-backend workflow runs without a TypeScript build.
 *
 * Uses a tiny model (all-MiniLM-L6-v2, ~25 MB) — the goal is to exercise the
 * runtime load + a real embedding call, not to validate any specific model.
 *
 * Run with either `bun scripts/verify-embedding-backend.mjs` or
 * `node scripts/verify-embedding-backend.mjs`.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const MODEL = "Xenova/all-MiniLM-L6-v2";
const EXPECTED_DIMS = 384;
const PINNED_ONNX_VERSION = "1.31.1";

const runtime = typeof globalThis.Bun !== "undefined" ? "bun" : "node";
console.log(
  `[verify-embedding] runtime=${runtime} platform=${process.platform} arch=${process.arch}`
);

function readPackageJsonNear(entry) {
  let dir = dirname(entry);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, "utf8"));
      // onnxruntime-common ships helper package.json files under dist/* without version.
      if (typeof parsed.version === "string" && parsed.version.length > 0) {
        return parsed;
      }
    }
    dir = dirname(dir);
  }
  throw new Error(`versioned package.json not found near ${entry}`);
}

const requireFromHere = createRequire(import.meta.url);
const transformersSpecifier = ["@huggingface", "transformers"].join("/");
const { pipeline, env } = requireFromHere(transformersSpecifier);

// Assert production-shaped CJS load resolved the pinned onnxruntime stack.
const onnxEntry = requireFromHere.resolve("onnxruntime-node");
const onnxPkg = readPackageJsonNear(onnxEntry);
if (onnxPkg.name !== "onnxruntime-node" || onnxPkg.version !== PINNED_ONNX_VERSION) {
  console.error(
    `[verify-embedding] FAIL: expected onnxruntime-node@${PINNED_ONNX_VERSION}, got ${onnxPkg.name}@${onnxPkg.version} at ${onnxEntry}`
  );
  process.exit(1);
}
console.log(`[verify-embedding] onnxruntime-node@${onnxPkg.version} at ${onnxEntry}`);

const commonEntry = createRequire(onnxEntry).resolve("onnxruntime-common");
const commonPkg = readPackageJsonNear(commonEntry);
if (commonPkg.name !== "onnxruntime-common" || commonPkg.version !== PINNED_ONNX_VERSION) {
  console.error(
    `[verify-embedding] FAIL: expected onnxruntime-common@${PINNED_ONNX_VERSION}, got ${commonPkg.name}@${commonPkg.version} at ${commonEntry}`
  );
  process.exit(1);
}
console.log(`[verify-embedding] onnxruntime-common@${commonPkg.version} at ${commonEntry}`);

// Mirror the plugin's runtime configuration.
env.allowLocalModels = true;
env.allowRemoteModels = true;
try {
  env.backends.onnx.wasm.numThreads = 1;
} catch {
  /* not fatal — only relevant for the wasm backend */
}

console.log(`[verify-embedding] loading feature-extraction pipeline for ${MODEL} ...`);
const extractor = await pipeline("feature-extraction", MODEL);

const samples = [
  "Hello world, this is a test.",
  "Hallo Welt, dies ist ein Test.", // non-English: exercises the multilingual tokenizer path
];

for (const text of samples) {
  const out = await extractor(text, { pooling: "mean", normalize: true });
  const dims = out.dims?.[out.dims.length - 1];
  if (dims !== EXPECTED_DIMS) {
    console.error(`[verify-embedding] FAIL: expected ${EXPECTED_DIMS} dims, got ${dims}`);
    process.exit(1);
  }
  const vec = Array.from(out.data);
  const allFinite = vec.every((x) => Number.isFinite(x));
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
  if (!allFinite || !(norm > 0.9 && norm < 1.1)) {
    console.error(
      `[verify-embedding] FAIL: bad vector (finite=${allFinite}, norm=${norm.toFixed(4)})`
    );
    process.exit(1);
  }
  console.log(
    `[verify-embedding] ok: "${text.slice(0, 24)}..." -> ${dims} dims, L2=${norm.toFixed(4)}`
  );
}

console.log("[verify-embedding] PASS — ONNX runtime loaded and embeddings produced.");
