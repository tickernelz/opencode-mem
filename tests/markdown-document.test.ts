import { describe, expect, it } from "bun:test";
import {
  contentHash,
  markdownIdFromRelPath,
  packMemoryMarkdown,
  readCaptureMetadata,
  parseMemoryMarkdown,
  titleFromRelPath,
} from "../src/services/markdown/document.js";

describe("markdown document pack/parse", () => {
  it("roundtrips plugin memory frontmatter", () => {
    const packed = packMemoryMarkdown({
      id: "mem_123_abc",
      content: "Remember to use bun test",
      type: "fact",
      tags: ["bun", "test"],
      containerTag: "opencode_project_deadbeef",
      createdAt: 1000,
      updatedAt: 2000,
      source: "manual",
      title: "Bun tip",
    });

    expect(packed.startsWith("---\n")).toBe(true);
    expect(packed).toContain('id: "mem_123_abc"');
    expect(packed).toContain("Remember to use bun test");

    const parsed = parseMemoryMarkdown(packed);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.frontmatter.id).toBe("mem_123_abc");
    expect(parsed.frontmatter.type).toBe("fact");
    expect(parsed.frontmatter.tags).toEqual(["bun", "test"]);
    expect(parsed.frontmatter.containerTag).toBe("opencode_project_deadbeef");
    expect(parsed.frontmatter.createdAt).toBe(1000);
    expect(parsed.frontmatter.updatedAt).toBe(2000);
    expect(parsed.frontmatter.source).toBe("manual");
    expect(parsed.frontmatter.title).toBe("Bun tip");
    expect(parsed.body.trim()).toBe("Remember to use bun test");
  });

  it("roundtrips capture provenance with escaped ids and a zero timestamp", () => {
    const capture = {
      promptId: 'prompt_"quoted":id',
      sessionID: "session_with\nnewline",
      captureTimestamp: 0,
    };
    const parsed = parseMemoryMarkdown(
      packMemoryMarkdown({ id: "mem_capture", content: "Captured fact", ...capture })
    );
    expect(readCaptureMetadata(parsed.frontmatter)).toEqual(capture);
  });

  it("rejects malformed capture fields instead of coercing them into links", () => {
    const raw = `---
id: "mem_capture"
promptId: 123
sessionID: false
captureTimestamp: "123"
---

Captured fact
`;
    const parsed = parseMemoryMarkdown(raw);
    expect(parsed.frontmatter.promptId).toBeUndefined();
    expect(parsed.frontmatter.sessionID).toBeUndefined();
    expect(parsed.frontmatter.captureTimestamp).toBeUndefined();
    for (const captureTimestamp of [-1, NaN, Infinity]) {
      expect(readCaptureMetadata({ promptId: " ", sessionID: "", captureTimestamp })).toEqual({});
    }
    expect(
      packMemoryMarkdown({ id: "mem_capture", content: "Captured fact", captureTimestamp: NaN })
    ).not.toContain("captureTimestamp:");
  });

  it("parses foreign wiki pages without our id", () => {
    const raw = `---
title: "Raneto Page"
name: "Alt Name"
tags: [wiki, llm]
---

# Hello

Body text here.
`;
    const parsed = parseMemoryMarkdown(raw);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.frontmatter.id).toBeUndefined();
    expect(parsed.frontmatter.title).toBe("Raneto Page");
    expect(parsed.frontmatter.name).toBe("Alt Name");
    expect(parsed.frontmatter.tags).toEqual(["wiki", "llm"]);
    expect(parsed.body).toContain("# Hello");
  });

  it("treats files without frontmatter as body-only", () => {
    const raw = "Just a plain note.\n\nSecond paragraph.";
    const parsed = parseMemoryMarkdown(raw);
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.body).toBe(raw);
    expect(Object.keys(parsed.frontmatter)).toHaveLength(0);
  });

  it("derives stable ids from relative paths", () => {
    const a = markdownIdFromRelPath("notes/foo.md");
    const b = markdownIdFromRelPath("notes/foo.md");
    const c = markdownIdFromRelPath("notes\\foo.md");
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a.startsWith("md_")).toBe(true);
    expect(a).not.toBe(markdownIdFromRelPath("notes/bar.md"));
  });

  it("titleFromRelPath strips extension", () => {
    expect(titleFromRelPath("folder/My Note.md")).toBe("My Note");
  });

  it("contentHash is stable", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
  });
});
