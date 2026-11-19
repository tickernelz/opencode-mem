import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { stripJsoncComments } from "./jsonc.js";

export type ModelOverride = {
  providerID: string;
  modelID: string;
};

/** Provider/model ids as the host reports them (dot, dash, underscore allowed). */
export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const KEYS = [
  ["providerID", "opencodeProvider"],
  ["modelID", "opencodeModel"],
] as const;

/**
 * Rewrites only the opencodeProvider/opencodeModel values in place so comments
 * and layout survive. Missing keys are appended to the root object.
 * The caller must validate the result before writing it to disk.
 */
export function applyModelOverride(content: string, override: ModelOverride): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = (content.trim().length > 0 ? content : `{${eol}}`).split(/\r?\n/);

  const found = new Set<string>();
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const matchable = !inBlockComment && !/^\s*\/[/*]/.test(line);
    const opensBlock = line.includes("/*");

    if (matchable) {
      for (const [field, key] of KEYS) {
        const pattern = new RegExp(`^(\\s*"${key}"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*")`);
        const match = pattern.exec(line);
        if (!match) continue;
        lines[i] = `${match[1]}${JSON.stringify(override[field])}${line.slice(match[0].length)}`;
        found.add(key);
      }
    }

    if (opensBlock && !line.includes("*/")) inBlockComment = true;
    else if (inBlockComment && line.includes("*/")) inBlockComment = false;
  }

  const missing = KEYS.filter(([, key]) => !found.has(key));
  if (missing.length > 0) {
    let closing = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]!.trim() === "}") {
        closing = i;
        break;
      }
    }
    if (closing === -1) {
      throw new Error("model-config: target file has no root object");
    }

    // The member that becomes second-to-last needs a separating comma.
    let previous = closing - 1;
    while (previous >= 0 && lines[previous]!.trim() === "") previous--;
    if (previous >= 0) {
      const trimmed = lines[previous]!.trimEnd();
      if (!trimmed.endsWith(",") && !trimmed.endsWith("{")) {
        lines[previous] = `${trimmed},`;
      }
    }

    const inserted = missing.map(
      ([field, key]) => `  "${key}": ${JSON.stringify(override[field])},`
    );
    inserted[inserted.length - 1] = inserted[inserted.length - 1]!.replace(/,$/, "");
    lines.splice(closing, 0, ...inserted);
  }

  return lines.join(eol);
}

/**
 * Writes the override to `targetPath` via tmp + rename. The rewritten content
 * must still parse as JSONC and carry the requested values, otherwise nothing
 * is written and the original file stays untouched.
 */
export function writeModelOverride(targetPath: string, override: ModelOverride): void {
  const original = existsSync(targetPath) ? readFileSync(targetPath, "utf-8") : "";
  const next = applyModelOverride(original, override);

  const parsed = JSON.parse(stripJsoncComments(next)) as Record<string, unknown>;
  if (
    parsed.opencodeProvider !== override.providerID ||
    parsed.opencodeModel !== override.modelID
  ) {
    throw new Error("model-config: rewrite would not apply the requested override");
  }

  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmpPath, next, "utf-8");
    renameSync(tmpPath, targetPath);
  } finally {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  }
}
