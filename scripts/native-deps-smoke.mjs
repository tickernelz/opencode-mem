import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const requireFromHere = createRequire(import.meta.url);
const projectRoot = process.cwd();
const lockfilePath = join(projectRoot, "package-lock.json");
const artifactPattern = /(?:\.node|\.dll|\.dylib|\.so(?:\.\d+)*)$/;
const nativeScriptPattern =
  /node-gyp|node-gyp-build|node-pre-gyp|prebuild|prebuild-install|cmake-js|install\/check|node\s+.*install/i;
const nativeDependencyPattern =
  /node-gyp|node-gyp-build|node-pre-gyp|prebuild|prebuild-install|cmake-js|node-addon-api|detect-libc|napi-build-utils/i;
const platformPackagePattern =
  /(^|[-_/])(win32|windows|linux|darwin|macos|x64|arm64|ia32|musl|glibc)([-_/]|$)/i;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function getPackageNameFromLockPath(lockPath) {
  const parts = lockPath.split("/");
  const nodeModulesIndex = parts.lastIndexOf("node_modules");
  if (nodeModulesIndex === -1) return null;
  const first = parts[nodeModulesIndex + 1];
  if (!first) return null;
  if (first.startsWith("@")) {
    const second = parts[nodeModulesIndex + 2];
    return second ? `${first}/${second}` : null;
  }
  return first;
}

function getLockPathForPackage(name) {
  return `node_modules/${name}`;
}

function isPlatformCompatible(pkg) {
  return (
    matchesSelectorList(pkg.os, process.platform) && matchesSelectorList(pkg.cpu, process.arch)
  );
}

function matchesSelectorList(selectors, current) {
  if (!Array.isArray(selectors) || selectors.length === 0) return true;
  const positives = selectors.filter((selector) => !selector.startsWith("!"));
  const negatives = selectors
    .filter((selector) => selector.startsWith("!"))
    .map((selector) => selector.slice(1));
  if (negatives.includes(current)) return false;
  return positives.length === 0 || positives.includes(current);
}

function collectRuntimeClosure(lockfile) {
  const packages = lockfile.packages ?? {};
  const root = packages[getLockPathForPackage("opencode-mem")];
  if (!root) {
    throw new Error("Installed opencode-mem package not found in package-lock.json");
  }

  const queue = ["opencode-mem"];
  const seen = new Set();

  while (queue.length > 0) {
    const name = queue.shift();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const entry = packages[getLockPathForPackage(name)];
    if (!entry) continue;
    for (const dependencyName of Object.keys(entry.dependencies ?? {})) queue.push(dependencyName);
    for (const dependencyName of Object.keys(entry.optionalDependencies ?? {}))
      queue.push(dependencyName);
  }

  return [...seen]
    .map((name) => ({
      name,
      lockPath: getLockPathForPackage(name),
      lockEntry: packages[getLockPathForPackage(name)],
    }))
    .filter((entry) => entry.lockEntry);
}

function findPackageDir(lockPath) {
  const packageDir = join(projectRoot, ...lockPath.split("/"));
  return existsSync(join(packageDir, "package.json")) ? packageDir : null;
}

function discoverArtifacts(packageDir) {
  const artifacts = [];
  const stack = [packageDir];
  let visited = 0;

  while (stack.length > 0 && visited < 2000) {
    const current = stack.pop();
    if (!current) continue;
    visited += 1;

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (artifactPattern.test(entry.name)) {
        artifacts.push(relative(packageDir, fullPath).split(sep).join("/"));
      }
    }
  }

  return artifacts;
}

function classifyNativeCandidate(pkg, packageDir, artifacts) {
  const reasons = [];
  const scripts = pkg.scripts ?? {};
  const dependencyNames = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ];

  if (pkg.gypfile === true) reasons.push("package.json gypfile=true");
  if (pkg.binary) reasons.push("package.json binary field");
  if (pkg.napi) reasons.push("package.json napi field");
  for (const [scriptName, script] of Object.entries(scripts)) {
    if (
      /^(preinstall|install|postinstall)$/.test(scriptName) &&
      nativeScriptPattern.test(String(script))
    ) {
      reasons.push(`${scriptName} script references native tooling`);
    }
  }
  if (dependencyNames.some((name) => nativeDependencyPattern.test(name))) {
    reasons.push("depends on native build/prebuild tooling");
  }
  if (
    Object.keys(pkg.optionalDependencies ?? {}).some((name) => platformPackagePattern.test(name))
  ) {
    reasons.push("has platform-specific optional dependencies");
  }
  if (platformPackagePattern.test(pkg.name ?? basename(packageDir))) {
    reasons.push("package name is platform-specific");
  }
  if (artifacts.length > 0) reasons.push("contains native binary artifacts");

  return reasons;
}

function isPlatformArtifactPackage(pkg, artifacts) {
  return platformPackagePattern.test(pkg.name ?? "") && artifacts.length > 0;
}

async function canLoadPackage(packageDir) {
  try {
    requireFromHere(packageDir);
    return { ok: true, mode: "require" };
  } catch (error) {
    if (!(error instanceof Error) || error.code !== "ERR_REQUIRE_ESM") {
      return { ok: false, mode: "require", error };
    }
  }

  try {
    await import(pathToFileURL(packageDir).href);
    return { ok: true, mode: "import" };
  } catch (error) {
    return { ok: false, mode: "import", error };
  }
}

function formatError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

const lockfile = readJson(lockfilePath);
const opencodeMemPkgPath = join(projectRoot, "node_modules", "opencode-mem", "package.json");
const rootPkg = existsSync(opencodeMemPkgPath) ? readJson(opencodeMemPkgPath) : readJson(join(projectRoot, "package.json"));
const candidates = [];
const failures = [];

for (const entry of collectRuntimeClosure(lockfile)) {
  const packageDir = findPackageDir(entry.lockPath);
  if (!packageDir) continue;

  const pkg = readJson(join(packageDir, "package.json"));
  if (!isPlatformCompatible(pkg)) continue;

  const artifacts = discoverArtifacts(packageDir);
  const reasons = classifyNativeCandidate(pkg, packageDir, artifacts);
  if (reasons.length === 0) continue;

  candidates.push({
    name: pkg.name ?? getPackageNameFromLockPath(entry.lockPath),
    packageDir,
    pkg,
    reasons,
    artifacts,
  });
}

if (candidates.length === 0) {
  failures.push(
    "No native dependency candidates were discovered in the opencode-mem runtime closure."
  );
}

for (const candidate of candidates) {
  const artifactOnly = isPlatformArtifactPackage(candidate.pkg, candidate.artifacts);
  const load = artifactOnly
    ? { ok: true, mode: "artifact-only" }
    : await canLoadPackage(candidate.packageDir);
  const artifactSummary = candidate.artifacts.length > 0 ? candidate.artifacts.join(", ") : "none";
  const relativeDir = relative(projectRoot, candidate.packageDir).split(sep).join("/");

  const isOptional = !!(
    rootPkg.optionalDependencies && rootPkg.optionalDependencies[candidate.name]
  );

  console.log(
    `${candidate.name}: ${load.ok ? `loaded via ${load.mode}` : "load failed"}${isOptional && !load.ok ? " (allowed for optional)" : ""}; artifacts=${artifactSummary}; reasons=${candidate.reasons.join("; ")}`
  );

  if (candidate.artifacts.length === 0 && !load.ok) {
    const msg = `${candidate.name} at ${relativeDir} has native markers but no native artifacts and could not load: ${formatError(load.error)}`;
    if (isOptional) console.log(`[WARN] ${msg}`);
    else failures.push(msg);
  }
  if (candidate.artifacts.length > 0 && !load.ok) {
    const msg = `${candidate.name} at ${relativeDir} has native artifacts but could not load on ${process.platform}/${process.arch}: ${formatError(load.error)}`;
    if (isOptional) console.log(`[WARN] ${msg}`);
    else failures.push(msg);
  }
}

if (failures.length > 0) {
  throw new Error(`Native dependency smoke failed:\n- ${failures.join("\n- ")}`);
}

console.log(`native dependency smoke test passed (${candidates.length} native candidates checked)`);
