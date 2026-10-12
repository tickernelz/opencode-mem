import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tursoConnectionManager } from "../src/services/turso/connection-manager.js";
import { isValidSkillId } from "../src/services/skills/types.js";

let tmpDir: string;

async function makeManager() {
  const { CONFIG } = await import("../src/config.js");
  CONFIG.storagePath = tmpDir;
  const { SkillsManager } = await import("../src/services/skills/skills-manager.js");
  return new SkillsManager();
}

describe("isValidSkillId", () => {
  it("accepts kebab-case ids", () => {
    expect(isValidSkillId("git-release")).toBe(true);
    expect(isValidSkillId("a")).toBe(true);
    expect(isValidSkillId("pr-review-v2")).toBe(true);
  });

  it("rejects invalid ids", () => {
    expect(isValidSkillId("Git-Release")).toBe(false);
    expect(isValidSkillId("-bad")).toBe(false);
    expect(isValidSkillId("bad-")).toBe(false);
    expect(isValidSkillId("bad--id")).toBe(false);
    expect(isValidSkillId("has space")).toBe(false);
  });
});

describe("SkillsManager", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "opencode-mem-skills-"));
  });

  afterEach(async () => {
    await tursoConnectionManager.closeAll();
    await new Promise((r) => setTimeout(r, 50));
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("creates, lists, updates, and deletes skills", async () => {
    const mgr = await makeManager();
    const created = await mgr.create({
      id: "git-release",
      name: "Git Release",
      description: "Prepare releases",
      content: "## Steps\n\n1. Tag\n2. Publish",
      autoinvoke: true,
      enabled: true,
    });

    expect(created.id).toBe("git-release");
    expect(created.name).toBe("Git Release");
    expect(created.autoinvoke).toBe(true);

    const listed = await mgr.list();
    expect(listed).toHaveLength(1);

    const updated = await mgr.update("git-release", {
      content: "## Updated",
      enabled: false,
    });
    expect(updated.content).toBe("## Updated");
    expect(updated.enabled).toBe(false);

    const enabledOnly = await mgr.list({ enabledOnly: true });
    expect(enabledOnly).toHaveLength(0);

    const deleted = await mgr.delete("git-release");
    expect(deleted).toBe(true);
    expect(await mgr.list()).toHaveLength(0);
  });

  it("rejects invalid and duplicate ids", async () => {
    const mgr = await makeManager();
    await expect(mgr.create({ id: "Bad_ID", name: "x", content: "body" })).rejects.toThrow(
      /Invalid skill id/
    );

    await mgr.create({ id: "ok-skill", name: "Ok", content: "body" });
    await expect(mgr.create({ id: "ok-skill", name: "Dup", content: "body" })).rejects.toThrow(
      /already exists/
    );
  });

  it("builds an OpenCode HTTP catalog", async () => {
    const mgr = await makeManager();
    await mgr.create({
      id: "review",
      name: "Review",
      description: "Review changes",
      content: "Review carefully.",
    });
    await mgr.create({
      id: "hidden",
      name: "Hidden",
      content: "off",
      enabled: false,
    });

    const catalog = await mgr.toHttpCatalog();
    expect(catalog.skills).toHaveLength(1);
    expect(catalog.skills[0]).toEqual({
      name: "review",
      version: expect.any(String),
      files: ["review.md"],
    });

    const md = await mgr.toCatalogMarkdown("review");
    expect(md).toContain('name: "Review"');
    expect(md).toContain("Review carefully.");
    expect(await mgr.toCatalogMarkdown("hidden")).toBeNull();
  });

  it("notifies listeners on change", async () => {
    const mgr = await makeManager();
    const { onSkillsChanged } = await import("../src/services/skills/skills-manager.js");
    let hits = 0;
    const stop = onSkillsChanged(() => {
      hits++;
    });
    await mgr.create({ id: "notify-me", name: "N", content: "c" });
    await mgr.update("notify-me", { name: "N2" });
    await mgr.delete("notify-me");
    stop();
    expect(hits).toBe(3);
  });
});
