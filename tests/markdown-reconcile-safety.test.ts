import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Separate processes isolate CONFIG, the native database, and filesystem spies
// from the suite's shared module mocks. Every scenario uses actual shard storage.
describe("markdown reconciliation deletion safety", () => {
  for (const scenario of [
    "missing-root",
    "empty-root",
    "no-markdown-files",
    "startup-missing-root",
    "root-is-file",
    "unreadable-root",
    "partial-directory",
    "failed-stat",
    "failed-read",
    "failed-upsert",
    "empty-note",
    "healthy-majority-delete",
    "fresh-empty",
    "incremental-missing",
    "incremental-empty",
    "incremental-partial",
    "incremental-delete",
    "incremental-rename",
    "single-read",
    "restored-vault",
  ]) {
    it(
      scenario,
      async () => {
        const home = mkdtempSync(join(tmpdir(), "md-reconcile-safety-"));
        try {
          const child = Bun.spawn(
            [
              process.execPath,
              join(import.meta.dir, "fixtures/markdown-reconcile-safety.ts"),
              scenario,
              home,
            ],
            {
              env: {
                ...process.env,
                HOME: home,
                USERPROFILE: home,
                XDG_CONFIG_HOME: home,
                OPENCODE_MEM_LOG_FILE: join(home, "test.log"),
              },
              stdout: "pipe",
              stderr: "pipe",
            }
          );
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          expect(code, stdout + stderr).toBe(0);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      },
      30_000
    );
  }
});
