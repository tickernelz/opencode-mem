import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveModelConfigPath } from "../src/config";
import {
  applyModelOverride,
  MODEL_ID_PATTERN,
  writeModelOverride,
} from "../src/services/model-config-writer";
import { stripJsoncComments } from "../src/services/jsonc";

function parse(content: string): Record<string, unknown> {
  return JSON.parse(stripJsoncComments(content)) as Record<string, unknown>;
}

describe("applyModelOverride", () => {
  it("replaces existing values and keeps comments and sibling keys", () => {
    const content = `{
  // Structured-output provider for tag migration
  "opencodeProvider": "magpie",
  /* model selection */
  "opencodeModel": "inherit",
  "storagePath": "~/.opencode-mem/data",
}
`;
    const next = applyModelOverride(content, { providerID: "magpie", modelID: "deepseek-v4" });

    expect(parse(next)).toMatchObject({
      opencodeProvider: "magpie",
      opencodeModel: "deepseek-v4",
      storagePath: "~/.opencode-mem/data",
    });
    expect(next).toContain("// Structured-output provider for tag migration");
    expect(next).toContain("/* model selection */");
  });

  it("appends missing keys to the root object", () => {
    const content = `{
  "storagePath": "~/.opencode-mem/data"
}`;
    const next = applyModelOverride(content, { providerID: "magpie", modelID: "deepseek-v4" });

    expect(parse(next)).toEqual({
      storagePath: "~/.opencode-mem/data",
      opencodeProvider: "magpie",
      opencodeModel: "deepseek-v4",
    });
  });

  it("appends missing keys when the last member already has a trailing comma", () => {
    const content = `{
  "storagePath": "~/data",
}`;
    const next = applyModelOverride(content, { providerID: "magpie", modelID: "deepseek-v4" });

    expect(parse(next)).toMatchObject({ opencodeProvider: "magpie", opencodeModel: "deepseek-v4" });
  });

  it("builds a root object for an empty file", () => {
    const next = applyModelOverride("", { providerID: "magpie", modelID: "deepseek-v4" });

    expect(parse(next)).toEqual({ opencodeProvider: "magpie", opencodeModel: "deepseek-v4" });
  });

  it("does not touch commented-out model keys", () => {
    const content = `{
  // "opencodeModel": "commented-out",
  /*
  "opencodeProvider": "commented-out",
  */
  "opencodeProvider": "magpie",
  "opencodeModel": "inherit"
}`;
    const next = applyModelOverride(content, { providerID: "magpie", modelID: "deepseek-v4" });

    expect(parse(next)).toEqual({ opencodeProvider: "magpie", opencodeModel: "deepseek-v4" });
    expect(next).toContain(`// "opencodeModel": "commented-out"`);
  });

  it("keeps CRLF line endings", () => {
    const content = `{\r\n  "opencodeModel": "inherit"\r\n}\r\n`;
    const next = applyModelOverride(content, { providerID: "magpie", modelID: "deepseek-v4" });

    expect(next).toContain("\r\n");
    expect(next.split(/\r?\n/).some((line) => line.includes(`"opencodeProvider"`))).toBe(true);
    expect(next.includes("\n\n")).toBe(false);
  });

  it("accepts model ids that contain a slash", () => {
    expect(MODEL_ID_PATTERN.test("auto/glm-5.3-flash")).toBe(true);
    expect(MODEL_ID_PATTERN.test("Inherit")).toBe(false);
  });

  it("does not treat /* inside comments or strings as a block comment", () => {
    const content = [
      "{",
      "  // Protects /api/* with a token.",
      '  "opencodeProvider": "magpie",',
      '  "opencodeModel": "inherit"',
      "}",
    ].join("\n");

    const next = applyModelOverride(content, { providerID: "codearts", modelID: "auto/glm" });

    expect(next.match(/"opencodeModel"/g)?.length).toBe(1);
    expect(next).toContain('"opencodeProvider": "codearts"');
    expect(next).toContain('"opencodeModel": "auto/glm"');
  });
});

describe("writeModelOverride", () => {
  it("writes the override and leaves no tmp file behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-mem-model-config-"));
    const path = join(dir, "opencode-mem.jsonc");
    writeFileSync(path, `{\n  // keep me\n  "opencodeModel": "inherit"\n}\n`, "utf-8");

    writeModelOverride(path, { providerID: "magpie", modelID: "deepseek-v4" });

    const written = readFileSync(path, "utf-8");
    expect(written).toContain("// keep me");
    expect(parse(written)).toMatchObject({
      opencodeModel: "deepseek-v4",
      opencodeProvider: "magpie",
    });
    expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("leaves the original file untouched when it does not parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-mem-model-config-"));
    const path = join(dir, "opencode-mem.jsonc");
    const broken = `{\n  "opencodeModel": "inherit",\n  oops\n}\n`;
    writeFileSync(path, broken, "utf-8");

    expect(() =>
      writeModelOverride(path, { providerID: "magpie", modelID: "deepseek-v4" })
    ).toThrow();
    expect(readFileSync(path, "utf-8")).toBe(broken);
  });
});

describe("resolveModelConfigPath", () => {
  it("prefers a project config that already sets the model keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-mem-project-"));
    const projectFile = join(dir, ".opencode", "opencode-mem.jsonc");
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(projectFile, `{ "opencodeModel": "inherit" }`, "utf-8");

    expect(resolveModelConfigPath(dir)).toBe(projectFile);
  });

  it("falls back to a global config when the project has none", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-mem-project-"));

    expect(resolveModelConfigPath(dir).endsWith("opencode-mem.jsonc")).toBe(true);
  });
});
