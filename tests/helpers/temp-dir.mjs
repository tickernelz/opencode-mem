import { rmSync } from "node:fs";

const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableRemoveError(error) {
  return RETRYABLE_REMOVE_CODES.has(error?.code);
}

export async function removeDirWithRetries(dir, attempts = 20) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableRemoveError(error) || attempt === attempts - 1) {
        throw error;
      }
      await sleep(50 * (attempt + 1));
    }
  }

  throw lastError;
}

export async function removeTempDirs(tempDirs) {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeDirWithRetries(dir);
  }
}
