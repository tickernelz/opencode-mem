import { rmSync } from "node:fs";

export async function cleanupTursoTestDirectory(baseDir?: string): Promise<void> {
  const [{ closeTursoAndInvalidateCaches }, { withSqliteFileLockRetry }] = await Promise.all([
    import("../src/services/turso/lifecycle.js"),
    import("../src/services/turso/sqlite-handle-release.js"),
  ]);

  await closeTursoAndInvalidateCaches();
  if (baseDir) {
    try {
      // Bounded retry: libsql 0.5.x keeps handles alive until GC, so a file can
      // stay locked long enough to blow a 5-10s test hook under parallel load.
      await withSqliteFileLockRetry(() => rmSync(baseDir, { recursive: true, force: true }), 2);
    } catch (error) {
      // Best-effort hygiene only: each test uses a unique mkdtemp dir, so a
      // leftover is harmless garbage, not a suite failure.
      console.warn(`cleanupTursoTestDirectory: could not remove ${baseDir}`, error);
    }
  }
}
