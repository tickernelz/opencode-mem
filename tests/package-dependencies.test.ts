import { describe, expect, it } from "bun:test";
import pkg from "../package.json";

describe("published dependency constraints", () => {
  it("uses @libsql/client for Turso persistence and vector search", () => {
    expect(pkg.dependencies["@libsql/client"]).toBeTruthy();
    expect(pkg.dependencies).not.toHaveProperty("usearch");
  });

  it("uses @huggingface/transformers (v4+) as the local embedding backend", () => {
    expect(pkg.dependencies["@huggingface/transformers"]).toMatch(/^\^?4\./);
    expect(pkg.dependencies).not.toHaveProperty("@xenova/transformers");
  });
});
