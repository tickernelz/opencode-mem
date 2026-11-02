import { describe, expect, it } from "bun:test";
import pkg from "../package.json";

describe("published dependency constraints", () => {
  it("uses @tursodatabase/database for local persistence (libsql kept for DiskANN migration)", () => {
    expect(pkg.dependencies["@tursodatabase/database"]).toBeTruthy();
    expect(pkg.dependencies["@libsql/client"]).toBeTruthy();
    // Profile learning lock uses @tursodatabase/database; @libsql/client remains
    // only for legacy DiskANN engine migration.
    expect(pkg.dependencies).not.toHaveProperty("usearch");
  });

  it("uses @huggingface/transformers (v4+) as the local embedding backend", () => {
    expect(pkg.dependencies["@huggingface/transformers"]).toMatch(/^\^?4\./);
    expect(pkg.dependencies).not.toHaveProperty("@xenova/transformers");
  });

  it("pins onnxruntime-node@1.31.1 as a direct dependency (nested install + Ort::Env fix)", () => {
    // Nested package.json overrides are ignored by npm/Arborist (#184). A direct
    // dependency is required so OpenCode nested installs keep a shipping binding.
    // 1.31.1 includes the Ort::Env teardown fix from 1.24.1 (#225). Intel Mac
    // (darwin/x64) is unsupported — @tursodatabase/database and fixed onnxruntime
    // releases ship no x64 binding (#27961).
    expect(pkg.dependencies["onnxruntime-node"]).toBe("1.31.1");
    expect((pkg as { overrides?: Record<string, string> }).overrides?.["onnxruntime-node"]).toBe(
      "1.31.1"
    );
  });
});
