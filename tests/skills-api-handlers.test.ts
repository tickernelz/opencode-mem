import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tursoConnectionManager } from "../src/services/turso/connection-manager.js";

let tmpDir: string;

describe("skills API handlers", () => {
  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "opencode-mem-skills-api-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = tmpDir;
    const { skillsManager } = await import("../src/services/skills/skills-manager.js");
    skillsManager.reset();
  });

  afterEach(async () => {
    const { skillsManager } = await import("../src/services/skills/skills-manager.js");
    skillsManager.reset();
    await tursoConnectionManager.closeAll();
    await new Promise((r) => setTimeout(r, 50));
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("supports CRUD through handlers", async () => {
    const {
      handleCreateSkill,
      handleListSkills,
      handleGetSkill,
      handleUpdateSkill,
      handleDeleteSkill,
      handleSkillsCatalogIndex,
      handleSkillsCatalogFile,
    } = await import("../src/services/api-handlers.js");

    const created = await handleCreateSkill({
      id: "ship-it",
      name: "Ship It",
      description: "Release flow",
      content: "## Ship\n\n1. Build\n2. Tag",
    });
    expect(created.success).toBe(true);
    expect(created.data?.id).toBe("ship-it");

    const listed = await handleListSkills();
    expect(listed.success).toBe(true);
    expect(listed.data?.items).toHaveLength(1);

    const got = await handleGetSkill("ship-it");
    expect(got.success).toBe(true);
    expect(got.data?.name).toBe("Ship It");

    const updated = await handleUpdateSkill("ship-it", { name: "Ship It Now" });
    expect(updated.success).toBe(true);
    expect(updated.data?.name).toBe("Ship It Now");

    const catalog = await handleSkillsCatalogIndex();
    expect(catalog.success).toBe(true);
    expect(catalog.data?.skills[0]?.name).toBe("ship-it");

    const file = await handleSkillsCatalogFile("ship-it");
    expect(file.success).toBe(true);
    expect(file.data?.markdown).toContain("## Ship");

    const deleted = await handleDeleteSkill("ship-it");
    expect(deleted.success).toBe(true);
    expect((await handleGetSkill("ship-it")).success).toBe(false);
  });
});
