#!/usr/bin/env node
/**
 * OpenCode-shaped nested-install regression for #210.
 *
 * Installs the packed plugin into a temporary consumer without root overrides.
 * When transformers and the direct pin declare different onnxruntime versions,
 * npm may keep nested onnxruntime-node@1.24.3. When they align (both 1.30.0),
 * npm dedupes — this fixture then plants a synthetic nested 1.24.3 under
 * transformers so the CJS resolve shim (#184 / #210) is still exercised.
 * Then verifies the production CJS prepare+load path pins the direct 1.30.0 stack.
 *
 * Unlike earlier revisions, Transformers is loaded through the production
 * `loadLocalTransformersBackend()` export (createRuntimeRequire + shim), not via
 * a separately constructed absolute createRequire() that would hide empty-referrer
 * failures inside compiled OpenCode/Bun hosts.
 *
 * When running under Bun, also compiles a minimal host binary that dynamically
 * imports the installed plugin — the same pattern OpenCode uses.
 *
 * npm may hoist dependencies to the consumer root (fixture/node_modules/...) while
 * OpenCode keeps them under the plugin package. Both layouts are accepted as long as
 * transformers can resolve a nested 1.24.x copy (real or synthetic) and the
 * production shim pins 1.30.0.
 *
 * Usage (from a built repo checkout):
 *   node scripts/verify-nested-onnxruntime-fixture.mjs
 *   bun scripts/verify-nested-onnxruntime-fixture.mjs
 *
 * Optional env:
 *   FIXTURE_DIR     — reuse an existing fixture root that already has opencode-mem installed
 *   SKIP_INSTALL    — when FIXTURE_DIR is set, skip pack/install
 *   SKIP_EMBEDDING  — skip the real feature-extraction smoke
 *   SKIP_COMPILE_HOST — skip Bun --compile host verification
 *   KEEP_FIXTURE    — keep the temp fixture directory
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PINNED = "1.30.0";
const NESTED_BAD = "1.24.3";
const runtime = typeof globalThis.Bun !== "undefined" ? "bun" : "node";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function log(msg) {
  console.log(`[nested-onnx-fixture] ${msg}`);
}

function fail(msg) {
  console.error(`[nested-onnx-fixture] FAIL: ${msg}`);
  process.exit(1);
}

function run(cmd, args, cwd, env = process.env) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  if (result.status !== 0) {
    const signal = result.signal ? ` (signal ${result.signal})` : "";
    fail(
      `${cmd} ${args.join(" ")} exited ${result.status}${signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
  return result.stdout;
}

function readPkgNear(entry) {
  let dir = dirname(entry);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf8"));
      // onnxruntime-common ships helper package.json files under dist/* without version.
      if (typeof pkg.version === "string" && pkg.version.length > 0) {
        return { path: candidate, pkg };
      }
    }
    dir = dirname(dir);
  }
  throw new Error(`versioned package.json not found near ${entry}`);
}

function findNestedOnnxruntime(searchRoots) {
  for (const root of searchRoots) {
    const nested = join(
      root,
      "node_modules",
      "@huggingface",
      "transformers",
      "node_modules",
      "onnxruntime-node"
    );
    const pkgPath = join(nested, "package.json");
    if (existsSync(pkgPath)) {
      return {
        root: nested,
        pkg: JSON.parse(readFileSync(pkgPath, "utf8")),
      };
    }
  }
  return null;
}

function findTransformersPackageJson(searchRoots) {
  for (const root of searchRoots) {
    const candidate = join(root, "node_modules", "@huggingface", "transformers", "package.json");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * When pin and transformers agree on onnxruntime-node, npm dedupes and there is
 * no nested copy. Plant a synthetic NESTED_BAD under transformers so the shim
 * regression (#184 / #210) still runs against a conflicting nested layout.
 */
function ensureSyntheticNestedBad(searchRoots) {
  const transformersPkg = findTransformersPackageJson(searchRoots);
  if (!transformersPkg) fail("transformers package.json not found for synthetic nest");
  const transformersRoot = dirname(transformersPkg);
  const nestedNode = join(transformersRoot, "node_modules", "onnxruntime-node");
  const nestedCommon = join(transformersRoot, "node_modules", "onnxruntime-common");

  mkdirSync(join(nestedNode, "dist"), { recursive: true });
  mkdirSync(join(nestedCommon, "dist", "cjs"), { recursive: true });
  writeFileSync(
    join(nestedNode, "package.json"),
    JSON.stringify({
      name: "onnxruntime-node",
      version: NESTED_BAD,
      main: "dist/index.js",
    })
  );
  writeFileSync(join(nestedNode, "dist", "index.js"), `module.exports = { nested: true };\n`);
  writeFileSync(
    join(nestedCommon, "package.json"),
    JSON.stringify({
      name: "onnxruntime-common",
      version: NESTED_BAD,
      main: "dist/cjs/index.js",
    })
  );
  writeFileSync(
    join(nestedCommon, "dist", "cjs", "index.js"),
    `module.exports = { nested: true };\n`
  );
  log(`planted synthetic nested onnxruntime-node@${NESTED_BAD} under transformers`);
  return {
    root: nestedNode,
    pkg: JSON.parse(readFileSync(join(nestedNode, "package.json"), "utf8")),
  };
}

async function verifyCompiledHost(pluginRoot) {
  if (runtime !== "bun") {
    log("skipping compiled-host check (requires Bun)");
    return;
  }
  if (process.env.SKIP_COMPILE_HOST === "1") {
    log("skipping compiled-host check (SKIP_COMPILE_HOST=1)");
    return;
  }

  const hostDir = mkdtempSync(join(tmpdir(), "opencode-mem-compiled-host-"));
  const entrySource = join(repoRoot, "scripts", "fixtures", "compiled-host-entry.mjs");
  const entryCopy = join(hostDir, "entry.ts");
  const outfile = join(hostDir, "compiled-host");
  writeFileSync(entryCopy, readFileSync(entrySource));
  // Match OpenCode's Bun.build compile options — plain `bun build --compile`
  // does not reproduce the empty-referrer failure from #210.
  writeFileSync(
    join(hostDir, "package.json"),
    JSON.stringify({ name: "opencode-mem-compiled-host", type: "module" }, null, 2)
  );
  writeFileSync(
    join(hostDir, "build.ts"),
    `
await Bun.build({
  entrypoints: ["./entry.ts"],
  conditions: ["bun", "node"],
  format: "esm",
  compile: {
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: true,
    autoloadPackageJson: true,
    outfile: ${JSON.stringify(outfile)},
  },
});
`
  );

  log(`compiling OpenCode-shaped Bun host -> ${outfile}`);
  run("bun", ["build.ts"], hostDir);

  const embeddingEntry = join(pluginRoot, "dist", "services", "embedding.js");
  const pluginEntry = pathToFileURL(embeddingEntry).href;
  log(`running compiled host against ${pluginEntry}`);
  const stdout = run(outfile, [], hostDir, {
    ...process.env,
    OPENCODE_MEM_PLUGIN_ENTRY: pluginEntry,
  });
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    fail(`compiled host did not print JSON status\nstdout:\n${stdout}`);
  }
  if (!parsed?.ok) fail(`compiled host reported failure: ${line}`);
  if (parsed.nodeVersion !== PINNED) {
    fail(`compiled host onnxruntime-node=${parsed.nodeVersion}, expected ${PINNED}`);
  }
  if (parsed.commonVersion !== PINNED) {
    fail(`compiled host onnxruntime-common=${parsed.commonVersion}, expected ${PINNED}`);
  }
  if (parsed.embeddingDims !== 384) {
    fail(`compiled host embeddingDims=${parsed.embeddingDims}, expected 384`);
  }
  if (!(parsed.embeddingNorm > 0.9 && parsed.embeddingNorm < 1.1)) {
    fail(`compiled host embeddingNorm=${parsed.embeddingNorm}, expected ~1.0`);
  }
  // `run()` already asserted exit status 0 / no crash signal after inference.
  log(
    `compiled host PASS — pinned node=${parsed.nodeEntry}; embedding dims=${parsed.embeddingDims} L2=${parsed.embeddingNorm}`
  );
  rmSync(hostDir, { recursive: true, force: true });
}

async function main() {
  log(`runtime=${runtime} platform=${process.platform} arch=${process.arch}`);

  let fixtureDir = process.env.FIXTURE_DIR ? resolve(process.env.FIXTURE_DIR) : null;
  let cleanup = null;

  if (!fixtureDir || process.env.SKIP_INSTALL !== "1") {
    const packDir = mkdtempSync(join(tmpdir(), "opencode-mem-pack-"));
    fixtureDir = mkdtempSync(join(tmpdir(), "opencode-mem-nested-"));
    cleanup = () => {
      rmSync(packDir, { recursive: true, force: true });
      rmSync(fixtureDir, { recursive: true, force: true });
    };

    log(`packing from ${repoRoot}`);
    run("npm", ["pack", "--pack-destination", packDir], repoRoot);
    const tarball = run("bash", ["-lc", `ls "${packDir}"/opencode-mem-*.tgz | head -1`]).trim();
    if (!tarball) fail("npm pack produced no tarball");

    // OpenCode installs plugins as a tiny consumer package that depends on the
    // plugin version, then hoists deps under that cache root (#210 reporter layout).
    // Intentionally NO root overrides — OpenCode nested installs ignore nested overrides (#184).
    writeFileSync(
      join(fixtureDir, "package.json"),
      JSON.stringify(
        {
          name: "opencode-mem-nested-fixture",
          private: true,
          dependencies: {
            "opencode-mem": `file:${tarball}`,
          },
        },
        null,
        2
      )
    );
    log(`installing into ${fixtureDir} (ignore-scripts, OpenCode-shaped hoist, no overrides)`);
    run("npm", ["install", "--ignore-scripts"], fixtureDir);
  }

  const pluginRoot = join(fixtureDir, "node_modules", "opencode-mem");
  if (!existsSync(pluginRoot)) fail(`plugin not installed at ${pluginRoot}`);

  const searchRoots = [pluginRoot, fixtureDir];
  // Diagnostic-only require anchored at the production embedding file. Production
  // loading must go through loadLocalTransformersBackend() below.
  const pluginRequire = createRequire(join(pluginRoot, "dist", "services", "embedding.js"));

  let directNodeEntry;
  try {
    directNodeEntry = pluginRequire.resolve("onnxruntime-node");
  } catch (error) {
    fail(`direct onnxruntime-node not resolvable from plugin: ${error}`);
  }
  const directPkg = readPkgNear(directNodeEntry).pkg;
  if (directPkg.name !== "onnxruntime-node" || directPkg.version !== PINNED) {
    fail(
      `direct onnxruntime-node is ${directPkg.name}@${directPkg.version}, expected onnxruntime-node@${PINNED}`
    );
  }
  log(`direct onnxruntime-node@${directPkg.version} at ${directNodeEntry}`);

  let nested = findNestedOnnxruntime(searchRoots);
  if (nested) {
    log(`nested onnxruntime-node@${nested.pkg.version} present under transformers`);
    if (nested.pkg.version === PINNED) {
      log(
        `nested version matches pin ${PINNED} (aligned deps / dedupe); planting synthetic ${NESTED_BAD}`
      );
      nested = ensureSyntheticNestedBad(searchRoots);
    } else if (nested.pkg.version !== NESTED_BAD) {
      log(`warning: unexpected nested version ${nested.pkg.version}`);
    }
  } else {
    log(
      `no nested onnxruntime under transformers (aligned pin/transformers ${PINNED}); planting synthetic ${NESTED_BAD}`
    );
    nested = ensureSyntheticNestedBad(searchRoots);
  }

  // Prove that a transformers-local require would prefer nested 1.24.x when present.
  if (nested.pkg.version !== PINNED) {
    const transformersPkg = findTransformersPackageJson(searchRoots);
    if (!transformersPkg) fail("transformers package.json not found");
    const nestedRequire = createRequire(transformersPkg);
    const nestedResolved = nestedRequire.resolve("onnxruntime-node");
    const resolvedPkg = readPkgNear(nestedResolved).pkg;
    if (resolvedPkg.version === PINNED) {
      fail(
        "expected transformers-local resolve to prefer nested 1.24.x before shim, but got pinned 1.30.0"
      );
    }
    log(`pre-shim transformers resolve -> ${nestedResolved} (@${resolvedPkg.version})`);
  }

  // Load production prepare + transformers through the real embedding module path.
  // This exercises createRuntimeRequire(import.meta) instead of a hand-built absolute require.
  const embeddingUrl = pathToFileURL(join(pluginRoot, "dist", "services", "embedding.js")).href;
  const embeddingMod = await import(embeddingUrl);
  if (typeof embeddingMod.loadLocalTransformersBackend !== "function") {
    fail("dist/memory/embedding.js does not export loadLocalTransformersBackend");
  }

  const transformers = await embeddingMod.loadLocalTransformersBackend();
  if (typeof transformers.pipeline !== "function" || !transformers.env) {
    fail("production loadLocalTransformersBackend did not expose pipeline/env");
  }

  const pinnedNode = pluginRequire.resolve("onnxruntime-node");
  const pinnedCommon = createRequire(pinnedNode).resolve("onnxruntime-common");
  const nodePkg = readPkgNear(pinnedNode).pkg;
  const commonPkg = readPkgNear(pinnedCommon).pkg;

  if (nodePkg.version !== PINNED) {
    fail(`after prepare, onnxruntime-node resolved to ${nodePkg.version} at ${pinnedNode}`);
  }
  if (commonPkg.version !== PINNED) {
    fail(`after prepare, onnxruntime-common resolved to ${commonPkg.version} at ${pinnedCommon}`);
  }

  const resolveUrl = pathToFileURL(
    join(pluginRoot, "dist", "services", "onnxruntime-resolve.js")
  ).href;
  const { getPinnedOnnxruntimePackageRoot } = await import(resolveUrl);
  const pinnedRoot = getPinnedOnnxruntimePackageRoot();
  if (!pinnedRoot.includes("onnxruntime-node")) {
    fail(`unexpected pinned root: ${pinnedRoot}`);
  }

  // From nested transformers context, shim must force both packages onto the pin.
  const transformersSpecifier = ["@huggingface", "transformers"].join("/");
  const transformersEntry = pluginRequire.resolve(transformersSpecifier);
  const fromTransformers = createRequire(transformersEntry);
  const shimmedNode = fromTransformers.resolve("onnxruntime-node");
  const shimmedCommon = fromTransformers.resolve("onnxruntime-common");
  if (readPkgNear(shimmedNode).pkg.version !== PINNED) {
    fail(`shim failed for onnxruntime-node: ${shimmedNode}`);
  }
  if (readPkgNear(shimmedCommon).pkg.version !== PINNED) {
    fail(`shim failed for onnxruntime-common: ${shimmedCommon}`);
  }

  log(`pinned node=${shimmedNode}`);
  log(`pinned common=${shimmedCommon}`);

  // Real dlopen + embedding path (optional skip for unit-speed local runs).
  if (process.env.SKIP_EMBEDDING !== "1") {
    const MODEL = "Xenova/all-MiniLM-L6-v2";
    const EXPECTED_DIMS = 384;
    transformers.env.allowLocalModels = true;
    transformers.env.allowRemoteModels = true;
    try {
      transformers.env.backends.onnx.wasm.numThreads = 1;
    } catch {
      /* wasm backend optional */
    }
    log(`loading feature-extraction pipeline for ${MODEL} ...`);
    const extractor = await transformers.pipeline("feature-extraction", MODEL);
    const out = await extractor("Hello world, nested onnxruntime fixture.", {
      pooling: "mean",
      normalize: true,
    });
    const dims = out.dims?.[out.dims.length - 1];
    if (dims !== EXPECTED_DIMS) {
      fail(`expected ${EXPECTED_DIMS} dims, got ${dims}`);
    }
    const vec = Array.from(out.data);
    const allFinite = vec.every((x) => Number.isFinite(x));
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
    if (!allFinite || !(norm > 0.9 && norm < 1.1)) {
      fail(`bad embedding vector (finite=${allFinite}, norm=${norm})`);
    }
    log(`embedding ok: ${dims} dims, L2=${norm.toFixed(4)}`);
  }

  await verifyCompiledHost(pluginRoot);

  log("PASS — nested fixture loads production CJS path on onnxruntime 1.30.0 stack");

  if (cleanup && process.env.KEEP_FIXTURE !== "1") cleanup();
}

main().catch((error) => {
  fail(error instanceof Error ? error.stack || error.message : String(error));
});
