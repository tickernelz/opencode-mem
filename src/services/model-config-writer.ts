import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { stripJsoncComments } from "./jsonc.js";

export type ModelOverride = {
  providerID: string;
  modelID: string;
};

/** Provider/model ids as the host reports them; slashes appear in ids like "auto/glm-5.3-flash". */
export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/;

const KEYS = [
  ["providerID", "opencodeProvider"],
  ["modelID", "opencodeModel"],
] as const;

/**
 * Tracks block-comment state across lines. A "/*" inside a string or a //
 * comment (e.g. the docs line mentioning /api/*) must not open a block.
 */
function endsInsideBlockComment(line: string, inBlock: boolean): boolean {
  let i = 0;
  while (i < line.length) {
    if (inBlock) {
      if (line.startsWith("*/", i)) {
        inBlock = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (line[i] === '"') {
      i += 1;
      while (i < line.length) {
        if (line[i] === "\\") {
          i += 2;
          continue;
        }
        if (line[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (line.startsWith("//", i)) return false;
    if (line.startsWith("/*", i)) {
      inBlock = true;
      i += 2;
      continue;
    }
    i += 1;
  }
  return inBlock;
}

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
    if (!inBlockComment) {
      for (const [field, key] of KEYS) {
        const pattern = new RegExp(`^(\\s*"${key}"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*")`);
        const match = pattern.exec(line);
        if (!match) continue;
        lines[i] = `${match[1]}${JSON.stringify(override[field])}${line.slice(match[0].length)}`;
        found.add(key);
      }
    }
    inBlockComment = endsInsideBlockComment(line, inBlockComment);
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
