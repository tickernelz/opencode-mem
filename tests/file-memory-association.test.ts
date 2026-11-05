import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  bindFilesToMemory,
  matchesFileMemory,
  type FileMemoryAssociation,
} from "../src/services/file-memory-association.js";
import type { ObservedFiles } from "../src/services/observed-files.js";
import { sanitizeMemoryContent } from "../src/services/privacy.js";

const workspace = "a".repeat(64);
const observed = (...paths: string[]): ObservedFiles => ({ version: 1, workspace, paths });
const digest = (content: string) => createHash("sha256").update(content).digest("hex");

// Construct legacy metadata independently of the new binder: old episodes
// associated every observed file, including ones the summary never discussed.
function legacyAssociation(paths: string[], content: string): FileMemoryAssociation {
  return { ...observed(...paths), contentHash: digest(content) };
}

const metadata = (association: FileMemoryAssociation | null) => ({
  source: "auto-capture",
  observedFiles: association,
});

describe("summary-supported observed-file associations", () => {
  it("keeps the named cache lesson and drops an incidentally observed vendor file", () => {
    const files = observed("src/cache.ts", "vendor/cache.ts");
    const summary =
      "Request: Repair the cached lookup in src/cache.ts.\n" +
      "Outcome: Keep failed entries out of the cache so retries can recover.";
    const association = bindFilesToMemory(files, summary);

    expect(association?.paths).toEqual(["src/cache.ts"]);
    expect(files.paths).toEqual(["src/cache.ts", "vendor/cache.ts"]);
    expect(matchesFileMemory(metadata(association), summary, observed("src/cache.ts"))).toBe(true);
    expect(matchesFileMemory(metadata(association), summary, observed("vendor/cache.ts"))).toBe(
      false
    );
  });

  it("keeps a named lesson learned from reading without requiring an edit", () => {
    const summary =
      "Reading `src/config.ts` showed that an empty environment override is intentionally ignored.";
    const association = bindFilesToMemory(observed("src/config.ts"), summary);
    expect(association?.paths).toEqual(["src/config.ts"]);
    expect(matchesFileMemory(metadata(association), summary, observed("src/config.ts"))).toBe(true);
  });

  it("requires observation as well as a mention, and returns null when none qualify", () => {
    expect(bindFilesToMemory(undefined, "The bug is in src/cache.ts.")).toBeNull();
    expect(bindFilesToMemory(observed(), "The bug is in src/cache.ts.")).toBeNull();
    expect(bindFilesToMemory(observed("src/cache.ts"), "The bug is in src/other.ts.")).toBeNull();
    expect(bindFilesToMemory(observed("src/cache.ts"), "The cache now works.")).toBeNull();
  });

  it("intersects explicitly named files with observed files without adding prose-only paths", () => {
    const association = bindFilesToMemory(
      observed("src/cache.ts", "src/config.ts", "vendor/cache.ts"),
      "Both src/config.ts and src/cache.ts use the same key; src/unseen.ts may be a future concern."
    );
    expect(association?.paths.toSorted()).toEqual(["src/cache.ts", "src/config.ts"]);
  });

  it("redacts the summary before selecting paths and binding its persisted content hash", () => {
    const summary =
      "Use src/cache.ts for the retry guard. <private>The private target is vendor/cache.ts.</private>";
    const clean = sanitizeMemoryContent(summary);
    const association = bindFilesToMemory(observed("src/cache.ts", "vendor/cache.ts"), summary);

    expect(association?.paths).toEqual(["src/cache.ts"]);
    expect(association?.contentHash).toBe(digest(clean));
    expect(matchesFileMemory(metadata(association), clean, observed("src/cache.ts"))).toBe(true);
    expect(matchesFileMemory(metadata(association), clean, observed("vendor/cache.ts"))).toBe(
      false
    );
    expect(
      bindFilesToMemory(
        observed("src/cache.ts"),
        "<private>Only src/cache.ts is mentioned.</private>"
      )
    ).toBeNull();
    expect(bindFilesToMemory(observed("src/cache.ts"), "<private>src/cache.ts")).toBeNull();
  });
});

describe("exact path reference boundaries", () => {
  it("accepts canonical bare, quoted and ./-prefixed references", () => {
    for (const summary of [
      "Update src/cache.ts to preserve the invariant.",
      "The lesson applies to `src/cache.ts`.",
      'The lesson applies to "src/cache.ts".',
      "The lesson applies to 'src/cache.ts'.",
      "The lesson applies to (src/cache.ts).",
      "The lesson applies to ./src/cache.ts.",
      "The lesson applies to `./src/cache.ts`.",
    ]) {
      expect(bindFilesToMemory(observed("src/cache.ts"), summary)?.paths).toEqual(["src/cache.ts"]);
    }
  });

  it("does not infer references from quoted longer paths or ambiguous punctuation", () => {
    for (const summary of [
      "The issue concerns `src/cache.ts backup`.",
      'The issue concerns "src/cache.ts backup".',
      "The issue concerns 'src/cache.ts backup'.",
      "The issue concerns src/cache.ts:backup.",
      "The issue concerns src/cache.ts,backup.",
      "The issue concerns src/cache.ts:12.",
      "The issue concerns `src/cache.ts:12`.",
      "The issue concerns “src/cache.ts”.",
    ]) {
      expect(bindFilesToMemory(observed("src/cache.ts"), summary)).toBeNull();
      expect(
        matchesFileMemory(
          metadata(legacyAssociation(["src/cache.ts"], summary)),
          summary,
          observed("src/cache.ts")
        )
      ).toBe(false);
    }
    const longerPath = "src/cache.ts backup";
    expect(
      bindFilesToMemory(observed(longerPath), `The issue concerns \`${longerPath}\`.`)?.paths
    ).toEqual([longerPath]);
    expect(bindFilesToMemory(observed(longerPath), `The issue concerns ${longerPath}.`)).toBeNull();
  });

  it("does not match longer path components or filename prefixes/suffixes", () => {
    for (const otherPath of [
      "other/src/cache.ts",
      "prefixsrc/cache.ts",
      "src/cache.ts.map",
      "src/cache.tsx",
      "src/cache.ts/child",
      "src/cache.ts-old",
      "src/cache.ts_backup",
      "other/./src/cache.ts",
    ]) {
      const summary = `The issue concerns ${otherPath}.`;
      expect(bindFilesToMemory(observed("src/cache.ts"), summary)).toBeNull();
      expect(
        matchesFileMemory(
          metadata(legacyAssociation(["src/cache.ts"], summary)),
          summary,
          observed("src/cache.ts")
        )
      ).toBe(false);
    }
  });

  it("does not treat absolute, URL-only or traversal references as canonical relative paths", () => {
    for (const otherPath of [
      "/src/cache.ts",
      "/repo/src/cache.ts",
      "C:/repo/src/cache.ts",
      "file:///repo/src/cache.ts",
      "https://example.test/src/cache.ts",
      "https://example.test/?file=src/cache.ts",
      "https://example.test/#src/cache.ts",
      "../src/cache.ts",
      "./../src/cache.ts",
      "src/../src/cache.ts",
    ]) {
      const summary = `Inspect ${otherPath} for details.`;
      expect(bindFilesToMemory(observed("src/cache.ts"), summary)).toBeNull();
      expect(
        matchesFileMemory(
          metadata(legacyAssociation(["src/cache.ts"], summary)),
          summary,
          observed("src/cache.ts")
        )
      ).toBe(false);
    }
  });

  it("uses Unicode-aware boundaries without case folding or Unicode normalization", () => {
    for (const otherPath of [
      "ésrc/cache.ts",
      "缓存src/cache.ts",
      "src/cache.tsé",
      "src/cache.ts缓存",
      "src/cache.ts\u0301",
      "src/Cache.ts",
      "SRC/cache.ts",
    ]) {
      expect(bindFilesToMemory(observed("src/cache.ts"), `Inspect ${otherPath}.`)).toBeNull();
    }
    expect(bindFilesToMemory(observed("src/café.ts"), "Inspect `src/cafe\u0301.ts`.")).toBeNull();
    expect(bindFilesToMemory(observed("src/缓存.ts"), "Inspect `src/缓存.ts`.")?.paths).toEqual([
      "src/缓存.ts",
    ]);
  });

  it("supports exact root filenames without matching them under unrelated directories", () => {
    for (const path of ["package.json", "Makefile", ".gitignore"]) {
      expect(bindFilesToMemory(observed(path), `The setting is in \`${path}\`.`)?.paths).toEqual([
        path,
      ]);
      expect(bindFilesToMemory(observed(path), `The setting is in \`other/${path}\`.`)).toBeNull();
      expect(bindFilesToMemory(observed(path), `The setting is in \`${path}.backup\`.`)).toBeNull();
    }
  });

  it("requires quotes for extensionless root filenames that could be ordinary prose", () => {
    for (const path of ["cache", "Makefile", "README"]) {
      const summary = `The lesson concerns ${path}.`;
      expect(bindFilesToMemory(observed(path), summary)).toBeNull();
      expect(
        matchesFileMemory(metadata(legacyAssociation([path], summary)), summary, observed(path))
      ).toBe(false);
      expect(bindFilesToMemory(observed(path), `The lesson concerns \`${path}\`.`)?.paths).toEqual([
        path,
      ]);
    }
  });

  it("matches spaces and regex metacharacters literally", () => {
    for (const path of ["src/cache layer.ts", "src/cache[old](v2)+.ts", "src/cache$.ts"]) {
      expect(bindFilesToMemory(observed(path), `The constraint is in \`${path}\`.`)?.paths).toEqual(
        [path]
      );
      expect(
        bindFilesToMemory(observed(path), `The constraint is in \`other/${path}\`.`)
      ).toBeNull();
    }
    expect(
      bindFilesToMemory(observed("src/cache[old](v2)+.ts"), "The constraint is in src/cacheov2.ts.")
    ).toBeNull();
    expect(
      bindFilesToMemory(
        observed("src/cache layer.ts"),
        "The constraint is in `src/cache  layer.ts`."
      )
    ).toBeNull();
  });
});

describe("legacy associations and content revisions", () => {
  it("rechecks legacy broad associations against what the summary actually names", () => {
    const summary = "In src/cache.ts, failed lookups must not poison retries.";
    const legacy = metadata(legacyAssociation(["src/cache.ts", "vendor/cache.ts"], summary));

    expect(matchesFileMemory(legacy, summary, observed("src/cache.ts"))).toBe(true);
    expect(matchesFileMemory(legacy, summary, observed("vendor/cache.ts"))).toBe(false);
    expect(matchesFileMemory(legacy, summary, observed("src/other.ts"))).toBe(false);
    expect(matchesFileMemory(legacy, summary, observed("vendor/cache.ts", "src/cache.ts"))).toBe(
      true
    );
  });

  it("does not revive private-only mentions even when a legacy digest matches raw content", () => {
    const summary = "The investigation is private: <private>src/cache.ts</private>.";
    const legacy = metadata(legacyAssociation(["src/cache.ts"], summary));
    expect(matchesFileMemory(legacy, summary, observed("src/cache.ts"))).toBe(false);
  });

  it("still requires the original source, workspace and valid content digest", () => {
    const summary = "src/cache.ts must retain the retry guard.";
    const association = legacyAssociation(["src/cache.ts"], summary);

    expect(
      matchesFileMemory(
        { source: "manual", observedFiles: association },
        summary,
        observed("src/cache.ts")
      )
    ).toBe(false);
    expect(
      matchesFileMemory(metadata(association), summary, {
        ...observed("src/cache.ts"),
        workspace: "b".repeat(64),
      })
    ).toBe(false);
    expect(
      matchesFileMemory(
        metadata({ ...association, contentHash: "invalid" }),
        summary,
        observed("src/cache.ts")
      )
    ).toBe(false);
    expect(
      matchesFileMemory(
        metadata({ ...association, contentHash: "b".repeat(64) }),
        summary,
        observed("src/cache.ts")
      )
    ).toBe(false);
    expect(matchesFileMemory(undefined, summary, observed("src/cache.ts"))).toBe(false);
  });

  it("invalidates a rewritten summary even when it still names the same file", () => {
    const original = "src/cache.ts must retain the retry guard.";
    const rewritten = "src/cache.ts now retries only after invalidating the failed entry.";
    const originalAssociation = bindFilesToMemory(observed("src/cache.ts"), original);
    expect(
      matchesFileMemory(metadata(originalAssociation), rewritten, observed("src/cache.ts"))
    ).toBe(false);
    const updatedAssociation = bindFilesToMemory(observed("src/cache.ts"), rewritten);
    expect(updatedAssociation?.contentHash).not.toBe(originalAssociation?.contentHash);
    expect(
      matchesFileMemory(metadata(updatedAssociation), rewritten, observed("src/cache.ts"))
    ).toBe(true);
  });
});
