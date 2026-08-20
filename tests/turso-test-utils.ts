import { rmSync } from "node:fs";
import { RETRYABLE_FILE_LOCK_CODES } from "../src/services/turso/sqlite-handle-release.js";

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
      // A lock error on Windows can only escape the retry with its budget
      // exhausted, so that is the sole path worth warning about.
      await withSqliteFileLockRetry(() => rmSync(baseDir, { recursive: true, force: true }), 1);
    } catch (error) {
      if (isExhaustedWindowsLock(error)) {
        // Best-effort hygiene only: each test uses a unique mkdtemp dir, so a
        // leftover is harmless garbage, not a suite failure.
        console.warn(`cleanupTursoTestDirectory: could not remove ${baseDir}`, error);
        return;
      }
      throw error;
    }
  }
}

export function isExhaustedWindowsLock(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (process.platform !== "win32" || !code) return false;
  return RETRYABLE_FILE_LOCK_CODES.has(code);
}
