import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertOnnxruntimeBindingPresent,
  formatMissingOnnxruntimeBindingError,
  formatOnnxruntimeInitError,
  getOnnxruntimeBindingPath,
  getOnnxruntimeNapiDirName,
  getPinnedOnnxruntimePackageRoot,
  installOnnxruntimeResolveShim,
  prepareOnnxruntimeForTransformers,
} from "../src/infra/onnxruntime-resolve.js";
import pkg from "../package.json";

const requireFromHere = createRequire(import.meta.url);
const PINNED = pkg.dependencies["onnxruntime-node"];

function transformersPackageRoot(): string {
  const entry = requireFromHere.resolve("@huggingface/transformers");
  let dir = dirname(entry);
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`transformers package root not found near ${entry}`);
}

function packageVersionNear(entry: string): string {
  let dir = dirname(entry);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
        name?: string;
        version?: string;
      };
      // onnxruntime-common ships helper package.json files under dist/* without version.
      if (typeof parsed.version === "string" && parsed.version.length > 0) {
        return parsed.version;
      }
    }
    dir = dirname(dir);
  }
  throw new Error(`versioned package.json not found near ${entry}`);
}

describe("onnxruntime resolve shim (#184 / #210)", () => {
  it("pins onnxruntime-node to the direct dependency package root", () => {
    const root = getPinnedOnnxruntimePackageRoot();
    expect(root.includes("onnxruntime-node")).toBe(true);
    const pinnedPkg = requireFromHere(`${root}/package.json`);
    expect(pinnedPkg.version).toBe(PINNED);
  });

  it("resolve shim forces require('onnxruntime-node') onto the direct dep", () => {
    installOnnxruntimeResolveShim();
    const pinned = requireFromHere.resolve("onnxruntime-node");
    const nestedRequire = createRequire(join(transformersPackageRoot(), "package.json"));
    expect(nestedRequire.resolve("onnxruntime-node")).toBe(pinned);
  });

  it("resolve shim forces require('onnxruntime-common') onto the pinned node stack", () => {
    installOnnxruntimeResolveShim();
    const pinnedNode = requireFromHere.resolve("onnxruntime-node");
    const pinnedCommon = createRequire(pinnedNode).resolve("onnxruntime-common");
    const nestedRequire = createRequire(join(transformersPackageRoot(), "package.json"));
    expect(nestedRequire.resolve("onnxruntime-common")).toBe(pinnedCommon);
  });

  it("binding path exists for the current platform (or documents the failure)", () => {
    const bindingPath = getOnnxruntimeBindingPath();
    if (existsSync(bindingPath)) {
      expect(() => assertOnnxruntimeBindingPresent()).not.toThrow();
    } else {
      expect(() => assertOnnxruntimeBindingPresent()).toThrow(
        /Local embedding native binding missing/
      );
    }
  });

  it("intel mac missing-binding message mentions remote embedding fallback", () => {
    const message = formatMissingOnnxruntimeBindingError("darwin", "x64");
    expect(message).toContain("darwin/x64");
    expect(message).toContain("embeddingApiUrl");
    expect(message).toContain("embeddingApiKey");
    expect(message).toContain("1.30.0");
    expect(message).toContain("unsupported");
  });

  it("discovers the napi layout shipped by the pinned onnxruntime-node package", () => {
    const napiDir = getOnnxruntimeNapiDirName();
    expect(napiDir).toMatch(/^napi-v\d+$/);
    const bindingPath = getOnnxruntimeBindingPath();
    expect(bindingPath.split(/[/\\]/)).toContain(napiDir);
    if (existsSync(bindingPath)) {
      expect(bindingPath.endsWith("onnxruntime_binding.node")).toBe(true);
    }
  });

  it("init error reports missing binding only when the pinned file is absent", () => {
    const rewritten = formatOnnxruntimeInitError(
      new Error("Cannot find module '.../napi-v3/darwin/nope/onnxruntime_binding.node'"),
      "darwin",
      "nope"
    );
    expect(rewritten.message).toContain("Local embedding native binding missing");
    expect(rewritten.message).toContain("darwin/nope");
  });

  it("init error preserves original cause when the pinned binding is present", () => {
    const bindingPath = getOnnxruntimeBindingPath();
    if (!existsSync(bindingPath)) return;

    const original = new Error(
      `dlopen(${bindingPath}): simulated nested onnxruntime-node load failure`
    );
    const rewritten = formatOnnxruntimeInitError(original);
    expect(rewritten.message).toContain(
      "ONNX runtime failed to load despite pinned binding being present"
    );
    expect(rewritten.message).toContain(bindingPath);
    expect(rewritten.message).toContain("simulated nested onnxruntime-node load failure");
    expect(rewritten.message).not.toMatch(/^Local embedding native binding missing/);
    expect((rewritten as Error & { cause?: unknown }).cause).toBe(original);
  });

  it("CJS transformers load after prepare exposes pipeline/env on the pinned stack", () => {
    prepareOnnxruntimeForTransformers();
    const specifier = ["@huggingface", "transformers"].join("/");
    const transformers = requireFromHere(specifier) as {
      pipeline: unknown;
      env: unknown;
    };
    expect(typeof transformers.pipeline).toBe("function");
    expect(transformers.env).toBeTruthy();

    const pinnedNode = requireFromHere.resolve("onnxruntime-node");
    const pinnedCommon = createRequire(pinnedNode).resolve("onnxruntime-common");
    expect(packageVersionNear(pinnedNode)).toBe(PINNED);
    expect(packageVersionNear(pinnedCommon)).toBe(PINNED);
  });

  it("isolated nested 1.24.3 layout is overridden by prepare shim", () => {
    const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const fixture = mkdtempSync(join(tmpdir(), "opencode-mem-nested-shim-"));
    try {
      const realNodeRoot = getPinnedOnnxruntimePackageRoot();
      const realNodeEntry = requireFromHere.resolve("onnxruntime-node");
      const realCommonEntry = createRequire(realNodeEntry).resolve("onnxruntime-common");
      let realCommonRoot = dirname(realCommonEntry);
      for (let i = 0; i < 5; i++) {
        if (existsSync(join(realCommonRoot, "package.json"))) break;
        realCommonRoot = dirname(realCommonRoot);
      }

      const nm = join(fixture, "node_modules");
      const transformersRoot = join(nm, "@huggingface", "transformers");
      const nestedNode = join(transformersRoot, "node_modules", "onnxruntime-node");
      const nestedCommon = join(transformersRoot, "node_modules", "onnxruntime-common");

      mkdirSync(join(transformersRoot, "dist"), { recursive: true });
      mkdirSync(join(nestedNode, "dist"), { recursive: true });
      mkdirSync(join(nestedCommon, "dist", "cjs"), { recursive: true });
      symlinkSync(realNodeRoot, join(nm, "onnxruntime-node"));
      symlinkSync(realCommonRoot, join(nm, "onnxruntime-common"));

      writeFileSync(
        join(transformersRoot, "package.json"),
        JSON.stringify({
          name: "@huggingface/transformers",
          version: "0.0.0-fixture",
          main: "./dist/transformers.node.cjs",
        })
      );
      writeFileSync(
        join(transformersRoot, "dist", "transformers.node.cjs"),
        `module.exports = { pipeline() {}, env: {} };\n`
      );
      writeFileSync(
        join(nestedNode, "package.json"),
        JSON.stringify({
          name: "onnxruntime-node",
          version: "1.24.3",
          main: "dist/index.js",
        })
      );
      writeFileSync(join(nestedNode, "dist", "index.js"), `module.exports = { nested: true };\n`);
      writeFileSync(
        join(nestedCommon, "package.json"),
        JSON.stringify({
          name: "onnxruntime-common",
          version: "1.24.3",
          main: "dist/cjs/index.js",
        })
      );
      writeFileSync(
        join(nestedCommon, "dist", "cjs", "index.js"),
        `module.exports = { nested: true };\n`
      );
      writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "module" }));

      const resolveModuleUrl = pathToFileURL(
        join(repoRoot, "src/infra/onnxruntime-resolve.ts")
      ).href;
      const harness = join(fixture, "harness.mjs");
      writeFileSync(
        harness,
        `
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function pkgVersion(entry) {
  let dir = dirname(entry);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, "utf8"));
      if (typeof parsed.version === "string" && parsed.version.length > 0) return parsed.version;
    }
    dir = dirname(dir);
  }
  throw new Error("versioned package.json missing near " + entry);
}

const fixtureRequire = createRequire(join(${JSON.stringify(transformersRoot)}, "package.json"));
const beforeNode = fixtureRequire.resolve("onnxruntime-node");
const beforeCommon = fixtureRequire.resolve("onnxruntime-common");
if (pkgVersion(beforeNode) !== "1.24.3") {
  throw new Error("fixture did not nest onnxruntime-node@1.24.3: " + beforeNode);
}
if (pkgVersion(beforeCommon) !== "1.24.3") {
  throw new Error("fixture did not nest onnxruntime-common@1.24.3: " + beforeCommon);
}

const resolveMod = await import(${JSON.stringify(resolveModuleUrl)});
resolveMod.prepareOnnxruntimeForTransformers();

const afterNode = fixtureRequire.resolve("onnxruntime-node");
const afterCommon = fixtureRequire.resolve("onnxruntime-common");
if (pkgVersion(afterNode) !== ${JSON.stringify(PINNED)}) {
  throw new Error("node not pinned: " + afterNode + " @" + pkgVersion(afterNode));
}
if (pkgVersion(afterCommon) !== ${JSON.stringify(PINNED)}) {
  throw new Error("common not pinned: " + afterCommon + " @" + pkgVersion(afterCommon));
}
if (afterNode.includes(${JSON.stringify(join("transformers", "node_modules"))})) {
  throw new Error("node still nested after shim: " + afterNode);
}
console.log("nested-shim-ok");
`
      );

      const result = spawnSync(process.execPath, [harness], {
        encoding: "utf8",
        cwd: fixture,
        env: {
          ...process.env,
          NODE_PATH: nm,
        },
      });
      if (result.status !== 0) {
        throw new Error(
          `nested shim harness failed (${result.status})\nstdout:${result.stdout}\nstderr:${result.stderr}`
        );
      }
      expect(result.stdout).toContain("nested-shim-ok");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
