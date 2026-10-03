import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createRuntimeRequire, type RuntimeImportMeta } from "../src/infra/runtime-require.js";

describe("createRuntimeRequire (#210 compiled host)", () => {
  it("falls back to Bun import.meta.require when no file anchor exists", () => {
    const fakeRequire = ((id: string) => ({ ok: id })) as NodeRequire;
    fakeRequire.resolve = ((id: string) => `/fake/${id}`) as NodeRequire["resolve"];

    const req = createRuntimeRequire({
      url: "",
      path: "",
      dirname: "",
      dir: "",
      require: fakeRequire,
    } as RuntimeImportMeta);

    expect(req).toBe(fakeRequire);
    expect(req.resolve("onnxruntime-node")).toBe("/fake/onnxruntime-node");
  });

  it("prefers createRequire(file anchor) over import.meta.require when both exist", () => {
    const fakeRequire = ((id: string) => ({ ok: id })) as NodeRequire;
    fakeRequire.resolve = ((id: string) => `/fake/${id}`) as NodeRequire["resolve"];

    const req = createRuntimeRequire({
      url: import.meta.url,
      require: fakeRequire,
    } as RuntimeImportMeta);

    // Anchored createRequire should win so we do not depend on Bun referrer quirks.
    expect(req).not.toBe(fakeRequire);
    expect(typeof req("node:path").join).toBe("function");
  });

  it("falls back to createRequire(import.meta.url) when url is valid", () => {
    const req = createRuntimeRequire(import.meta);
    // Resolving a builtin proves the require is usable without depending on Bun-only APIs.
    expect(typeof req("node:path").join).toBe("function");
    expect(req.resolve("node:module")).toContain("module");
  });

  it("uses import.meta.path when url is empty", () => {
    const path =
      typeof (import.meta as RuntimeImportMeta).path === "string"
        ? (import.meta as RuntimeImportMeta).path!
        : new URL(import.meta.url).pathname;
    const req = createRuntimeRequire({
      url: "",
      path,
    } as RuntimeImportMeta);
    const expected = createRequire(path).resolve("node:fs");
    expect(req.resolve("node:fs")).toBe(expected);
  });

  it("uses import.meta.dirname as a filename anchor when url/path are empty", () => {
    const dirname = new URL(".", import.meta.url).pathname;
    const req = createRuntimeRequire({
      url: "",
      dirname,
    } as RuntimeImportMeta);
    expect(typeof req("node:path").join).toBe("function");
  });

  it("throws a concrete diagnostic when no usable anchor exists", () => {
    expect(() =>
      createRuntimeRequire({
        url: "",
        path: "",
        dirname: "",
        dir: "",
      } as RuntimeImportMeta)
    ).toThrow(/Unable to create a module require.*#210/);
  });

  it("resolves plugin packages when import.meta.url is empty but path is set", () => {
    // Bun's missing-module errors often say `from ''` even with a valid require;
    // the regression is failing to resolve an installed package under an empty url.
    const path =
      typeof (import.meta as RuntimeImportMeta).path === "string"
        ? (import.meta as RuntimeImportMeta).path!
        : new URL(import.meta.url).pathname;
    const req = createRuntimeRequire({
      url: "",
      path,
    } as RuntimeImportMeta);
    const resolved = req.resolve("@huggingface/transformers");
    expect(resolved.replaceAll("\\", "/")).toContain("@huggingface/transformers");
    // Do not load transformers here: another test covers the production load.
    // Loading its native ONNX stack twice in separate Bun test modules can crash
    // Bun 1.3.14 on macOS x64 during process teardown after all tests passed.
    expect(existsSync(resolved)).toBe(true);
  });
});
