import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLocalOnnxDtype } from "../src/services/embedding.js";

const MODEL = "org/quantized-embed";

function withCache(setup: (cacheRoot: string, modelDir: string, onnxDir: string) => void): string {
  const cacheRoot = mkdtempSync(join(tmpdir(), "opencode-mem-onnx-dtype-"));
  const modelDir = join(cacheRoot, MODEL);
  const onnxDir = join(modelDir, "onnx");
  mkdirSync(onnxDir, { recursive: true });
  setup(cacheRoot, modelDir, onnxDir);
  return cacheRoot;
}

function writeConfig(modelDir: string, transformersJsConfig: Record<string, unknown>): void {
  writeFileSync(
    join(modelDir, "config.json"),
    JSON.stringify({ model_type: "bert", "transformers.js_config": transformersJsConfig }),
    "utf-8"
  );
}

function touchOnnx(onnxDir: string, fileName: string): void {
  writeFileSync(join(onnxDir, fileName), "stub");
}

describe("resolveLocalOnnxDtype", () => {
  it("detects q8 from model_quantized.onnx when no config dtype is declared", () => {
    const cacheRoot = withCache((_cacheRoot, _modelDir, onnxDir) => {
      touchOnnx(onnxDir, "model_quantized.onnx");
    });
    try {
      expect(resolveLocalOnnxDtype(MODEL, cacheRoot)).toBe("q8");
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("prefers declared string dtype over missing fp32 weights", () => {
    const cacheRoot = withCache((_cacheRoot, modelDir, onnxDir) => {
      writeConfig(modelDir, { dtype: "q8" });
      touchOnnx(onnxDir, "model_quantized.onnx");
    });
    try {
      expect(resolveLocalOnnxDtype(MODEL, cacheRoot)).toBe("q8");
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("does not override per-file object dtype with a cache probe", () => {
    const cacheRoot = withCache((_cacheRoot, modelDir, onnxDir) => {
      writeConfig(modelDir, { dtype: { model: "q8" } });
      touchOnnx(onnxDir, "model_quantized.onnx");
    });
    try {
      expect(resolveLocalOnnxDtype(MODEL, cacheRoot)).toBeUndefined();
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("prefers fp32 when both fp32 and q8 weights are cached", () => {
    const cacheRoot = withCache((_cacheRoot, _modelDir, onnxDir) => {
      touchOnnx(onnxDir, "model.onnx");
      touchOnnx(onnxDir, "model_quantized.onnx");
    });
    try {
      expect(resolveLocalOnnxDtype(MODEL, cacheRoot)).toBe("fp32");
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("returns undefined for an empty cache", () => {
    const cacheRoot = withCache(() => {
      /* empty model dir with only onnx/ */
    });
    try {
      expect(resolveLocalOnnxDtype(MODEL, cacheRoot)).toBeUndefined();
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("detects q4f16 from model_q4f16.onnx", () => {
    const cacheRoot = withCache((_cacheRoot, _modelDir, onnxDir) => {
      touchOnnx(onnxDir, "model_q4f16.onnx");
    });
    try {
      expect(resolveLocalOnnxDtype(MODEL, cacheRoot)).toBe("q4f16");
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});
