export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  content: string;
  autoinvoke: boolean;
  enabled: boolean;
  containerTag: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SkillInput {
  id: string;
  name: string;
  description?: string;
  content: string;
  autoinvoke?: boolean;
  enabled?: boolean;
  containerTag?: string | null;
}

export interface SkillUpdate {
  name?: string;
  description?: string;
  content?: string;
  autoinvoke?: boolean;
  enabled?: boolean;
  containerTag?: string | null;
}

/** OpenCode-compatible skill id: lowercase kebab-case, 1–64 chars. */
export const SKILL_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidSkillId(id: string): boolean {
  return id.length >= 1 && id.length <= 64 && SKILL_ID_PATTERN.test(id);
}
