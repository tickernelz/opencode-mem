/**
 * Force resolution of `onnxruntime-node` (and its `onnxruntime-common`) to this
 * package's direct dependency stack.
 *
 * OpenCode installs plugins nested under its own cache. npm/Arborist only honors
 * `overrides` at the install root, so `@huggingface/transformers` would otherwise
 * keep nested `onnxruntime-node@1.24.3` (no darwin/x64 binding). See #184 / #158 / #210.
 *
 * We pin onnxruntime-node@1.30.0:
 * - 1.21.0–1.23.2 crash during macOS Ort::Env process-exit teardown (#225 /
 *   microsoft/onnxruntime#24579); the fix shipped in 1.24.1
 * - fixed releases still lack darwin/x64 binaries (microsoft/onnxruntime#27961);
 *   Intel Mac (darwin/x64) is unsupported for local embeddings
 * - Aligns with @huggingface/transformers' declared onnxruntime-node dependency
 *
 * Transformers must be loaded via its CJS export so this Module._resolveFilename
 * shim applies; the ESM entry's static `import "onnxruntime-node"` bypasses it.
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRuntimeRequire } from "./runtime-require.js";

const PACKAGE_NAME = "onnxruntime-node";
const COMMON_PACKAGE = "onnxruntime-common";
const PINNED_VERSION_HINT = "1.30.0";
const requireFromHere = createRuntimeRequire(import.meta);

let shimInstalled = false;
let pinnedPackageRoot: string | null = null;
let pinnedNodeEntry: string | null = null;
let pinnedCommonEntry: string | null = null;

function getPinnedOnnxruntimeEntry(): string {
  if (pinnedNodeEntry) return pinnedNodeEntry;
  pinnedNodeEntry = requireFromHere.resolve(PACKAGE_NAME);
  return pinnedNodeEntry;
}

function getPinnedOnnxruntimeCommonEntry(): string {
  if (pinnedCommonEntry) return pinnedCommonEntry;
  // Resolve common from the pinned node package so we always get the pinned stack,
  // whether the package manager hoists it or nests it under onnxruntime-node.
  pinnedCommonEntry = createRequire(getPinnedOnnxruntimeEntry()).resolve(COMMON_PACKAGE);
  return pinnedCommonEntry;
}

export function getPinnedOnnxruntimePackageRoot(): string {
  if (pinnedPackageRoot) return pinnedPackageRoot;
  const entry = getPinnedOnnxruntimeEntry();
  // package entry is typically …/dist/index.js — walk up to package root
  let dir = dirname(entry);
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, "package.json"))) {
      pinnedPackageRoot = dir;
      return dir;
    }
    dir = dirname(dir);
  }
  pinnedPackageRoot = dirname(entry);
  return pinnedPackageRoot;
}

/**
 * Resolve the N-API layout directory shipped by the pinned onnxruntime-node
 * package (`napi-v3` for 1.20.x, `napi-v6` for 1.22.x, …).
 */
export function getOnnxruntimeNapiDirName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  const binDir = join(getPinnedOnnxruntimePackageRoot(), "bin");
  if (!existsSync(binDir)) return "napi-v3";

  let entries: string[];
  try {
    entries = readdirSync(binDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^napi-v\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number(a.slice("napi-v".length)) - Number(b.slice("napi-v".length)));
  } catch {
    return "napi-v3";
  }

  // Prefer a layout that actually contains the platform binding.
  for (let i = entries.length - 1; i >= 0; i--) {
    const name = entries[i]!;
    if (existsSync(join(binDir, name, platform, arch, "onnxruntime_binding.node"))) {
      return name;
    }
  }

  return entries.at(-1) ?? "napi-v3";
}

export function getOnnxruntimeBindingPath(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  return join(
    getPinnedOnnxruntimePackageRoot(),
    "bin",
    getOnnxruntimeNapiDirName(platform, arch),
    platform,
    arch,
    "onnxruntime_binding.node"
  );
}

export function formatMissingOnnxruntimeBindingError(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  const bindingPath = getOnnxruntimeBindingPath(platform, arch);
  const intelHint =
    platform === "darwin" && arch === "x64"
      ? ` Intel Mac (darwin/x64) is unsupported for local embeddings: onnxruntime-node@${PINNED_VERSION_HINT} ships no x64 binding (microsoft/onnxruntime#27961). Configure remote embeddings via embeddingApiUrl + embeddingApiKey, or use Apple Silicon, Linux, or Windows.`
      : ` Configure remote embeddings via embeddingApiUrl + embeddingApiKey, or reinstall the plugin so onnxruntime-node@${PINNED_VERSION_HINT} is used.`;
  return `Local embedding native binding missing for ${platform}/${arch} at ${bindingPath}.${intelHint}`;
}

/**
 * Rewrite onnxruntime-related init failures.
 *
 * When the pinned binding is absent, keep the clear "missing" message.
 * When it is present, preserve the original error so nested-1.24 / dlopen /
 * codesign failures are not misreported as a missing pinned binding (#210).
 */
export function formatOnnxruntimeInitError(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const isOnnxRelated =
    message.includes("onnxruntime_binding.node") ||
    message.includes("onnxruntime-node") ||
    message.includes("onnxruntime-common") ||
    /napi-v\d+\/[^/]+\/[^/]+/.test(message);

  if (!isOnnxRelated) {
    return error instanceof Error ? error : new Error(message);
  }

  const bindingPath = getOnnxruntimeBindingPath(platform, arch);
  if (!existsSync(bindingPath)) {
    return new Error(formatMissingOnnxruntimeBindingError(platform, arch), { cause: error });
  }

  const intelHint =
    platform === "darwin" && arch === "x64"
      ? ` Intel Mac (darwin/x64) is unsupported for local embeddings; opencode-mem pins ${PINNED_VERSION_HINT} (no x64 binding).`
      : "";

  return new Error(
    `ONNX runtime failed to load despite pinned binding being present at ${bindingPath}. Original error: ${message}.${intelHint} If this persists after updating, clear OpenCode's plugin cache (~/.cache/opencode/packages/opencode-mem@*) and reinstall, or configure remote embeddings via embeddingApiUrl + embeddingApiKey.`,
    { cause: error }
  );
}

export function assertOnnxruntimeBindingPresent(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): void {
  const bindingPath = getOnnxruntimeBindingPath(platform, arch);
  if (!existsSync(bindingPath)) {
    throw new Error(formatMissingOnnxruntimeBindingError(platform, arch));
  }
}

function resolvePinnedRequest(
  request: string,
  packageName: string,
  pinnedEntry: string
): string | null {
  if (request !== packageName && !request.startsWith(`${packageName}/`)) {
    return null;
  }
  try {
    if (packageName === PACKAGE_NAME) {
      return requireFromHere.resolve(request);
    }
    return createRequire(getPinnedOnnxruntimeEntry()).resolve(request);
  } catch {
    if (request === packageName) return pinnedEntry;
    return null;
  }
}

/**
 * Patch Module._resolveFilename so require() of onnxruntime-node / onnxruntime-common
 * from nested transformers resolves to our direct pinned dependency stack.
 */
export function installOnnxruntimeResolveShim(): void {
  if (shimInstalled) return;

  // Resolve our pin first so a missing direct dep fails before transformers loads.
  const pinnedEntry = getPinnedOnnxruntimeEntry();
  const pinnedCommon = getPinnedOnnxruntimeCommonEntry();

  const Module = requireFromHere("node:module") as {
    _resolveFilename: (
      request: string,
      parent: unknown,
      isMain: boolean,
      options?: unknown
    ) => string;
  };

  const original = Module._resolveFilename;
  Module._resolveFilename = function (
    this: unknown,
    request: string,
    parent: unknown,
    isMain: boolean,
    options?: unknown
  ): string {
    // Only intercept the onnx stack. Forwarding every other request through a
    // wrapped _resolveFilename is required, but must not alter Bun --compile
    // parent handling for unrelated packages (#210 follow-up).
    const pinnedNode = resolvePinnedRequest(request, PACKAGE_NAME, pinnedEntry);
    if (pinnedNode) return pinnedNode;

    const pinnedCommonResolved = resolvePinnedRequest(request, COMMON_PACKAGE, pinnedCommon);
    if (pinnedCommonResolved) return pinnedCommonResolved;

    return original.call(this, request, parent, isMain, options);
  };

  shimInstalled = true;
}

/** Install resolve shim and fail fast if the platform binding is absent. */
export function prepareOnnxruntimeForTransformers(): void {
  installOnnxruntimeResolveShim();
  assertOnnxruntimeBindingPresent();
}
