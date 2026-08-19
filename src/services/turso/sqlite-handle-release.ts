type RuntimeWithGarbageCollector = typeof globalThis & {
  Bun?: {
    gc?: (force?: boolean) => void;
  };
  gc?: () => void;
};

const GC_PASSES = 3;
const FILE_LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1600, 3200];
const RETRYABLE_FILE_LOCK_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * libsql 0.5.x leaves prepared-statement handles alive until garbage collection.
 * Collect them before Windows file swaps/removals that require exclusive access.
 *
 * Upstream: https://github.com/tursodatabase/libsql-js/issues/228
 */
export async function collectReleasedSqliteHandles(): Promise<void> {
  if (process.platform !== "win32") return;

  const runtime = globalThis as RuntimeWithGarbageCollector;
  const bunGc = runtime.Bun?.gc;
  const globalGc = runtime.gc;

  if (!bunGc && !globalGc) return;

  for (let pass = 0; pass < GC_PASSES; pass += 1) {
    bunGc?.(true);
    globalGc?.();
    await delay(0);
  }
}

/**
 * Retries Windows file mutations while stable libsql releases native handles.
 * Non-lock errors and non-Windows platforms fail immediately.
 */
export async function withSqliteFileLockRetry<T>(
  operation: () => T | Promise<T>,
  maxAttempts: number = FILE_LOCK_RETRY_DELAYS_MS.length
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      const retryDelay = FILE_LOCK_RETRY_DELAYS_MS[attempt];
      if (
        process.platform !== "win32" ||
        !code ||
        !RETRYABLE_FILE_LOCK_CODES.has(code) ||
        retryDelay === undefined ||
        attempt >= maxAttempts
      ) {
        throw error;
      }

      await collectReleasedSqliteHandles();
      await delay(retryDelay);
    }
  }
}
