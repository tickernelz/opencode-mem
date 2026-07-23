export const SCOPE_HASH_PATTERN = /^[a-f0-9]{16}$/;

export function isValidScopeHash(hash: string): boolean {
  return SCOPE_HASH_PATTERN.test(hash);
}

export function assertSafeScopeHash(scopeHash: string): void {
  if (!isValidScopeHash(scopeHash)) {
    throw new Error(`Invalid scope hash: expected 16 lowercase hex characters, got "${scopeHash}"`);
  }
}

export function extractScopeFromContainerTag(containerTag: string): {
  scope: "user" | "project";
  hash: string;
} {
  const parts = containerTag.split("_");
  if (parts.length < 3) {
    throw new Error(
      `Invalid containerTag: expected format {prefix}_{user|project}_{16hex}, got "${containerTag}"`
    );
  }

  const hash = parts[parts.length - 1]!;
  const scope = parts[parts.length - 2];

  if (scope !== "user" && scope !== "project") {
    throw new Error(`Invalid containerTag scope: "${scope}" in "${containerTag}"`);
  }

  if (!isValidScopeHash(hash)) {
    throw new Error(
      `Invalid containerTag hash: expected 16 lowercase hex characters in "${containerTag}"`
    );
  }

  return { scope, hash };
}

export function tryExtractScopeFromContainerTag(
  containerTag: string
): { scope: "user" | "project"; hash: string } | null {
  try {
    return extractScopeFromContainerTag(containerTag);
  } catch {
    return null;
  }
}

export function resolveMemoryScope(
  scope: "project" | "all-projects",
  containerTag: string
): { scope: "user" | "project"; hash: string } {
  if (scope === "all-projects") {
    return { scope: "project", hash: "" };
  }
  return extractScopeFromContainerTag(containerTag);
}
