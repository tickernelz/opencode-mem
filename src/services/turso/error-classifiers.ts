/** Turso rejects VACUUM unless the experimental `vacuum` feature is enabled. */
const VACUUM_UNSUPPORTED_PATTERNS = [/VACUUM is an experimental feature/i, /experimental-vacuum/i];

/** DiskANN / index delete when the index entry is already gone (row may still exist). */
const IDX_DELETE_MISMATCH_PATTERNS = [
  /IdxDelete:\s*no matching index entry/i,
  /no matching index entry found for key/i,
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isVacuumUnsupportedError(error: unknown): boolean {
  const message = errorMessage(error);
  return VACUUM_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(message));
}

/** Only IdxDelete mismatch — not every `Corrupt database:*` error. */
export function isIdxDeleteMismatchError(error: unknown): boolean {
  const message = errorMessage(error);
  return IDX_DELETE_MISMATCH_PATTERNS.some((pattern) => pattern.test(message));
}
