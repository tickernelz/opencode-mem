/** OpenCode-compatible skill id: lowercase kebab-case, 1–64 chars. */
export const SKILL_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Derive a skill id from a display name (empty string if nothing usable). */
export function slugifySkillId(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return SKILL_ID_PATTERN.test(slug) ? slug : "";
}

/** Pick an unused id from a name; falls back to `skill` / `skill-2` etc. */
export function allocateSkillId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugifySkillId(name) || "skill";
  if (!used.has(base)) return base;

  for (let n = 2; n < 10_000; n++) {
    const suffix = `-${n}`;
    const maxBase = Math.max(1, 64 - suffix.length);
    const candidate = `${base.slice(0, maxBase).replace(/-+$/g, "")}${suffix}`;
    if (SKILL_ID_PATTERN.test(candidate) && !used.has(candidate)) return candidate;
  }

  return `skill-${Date.now().toString(36)}`.slice(0, 64);
}
