import { createHash } from "node:crypto";
import { basename } from "node:path";

export interface MemoryCaptureMetadata {
  promptId?: string;
  sessionID?: string;
  captureTimestamp?: number;
}

/** Only persist well-formed capture provenance; other metadata stays in the index. */
export function readCaptureMetadata(input: Record<string, unknown>): MemoryCaptureMetadata {
  const capture: MemoryCaptureMetadata = {};
  for (const key of ["promptId", "sessionID"] as const) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) capture[key] = value;
  }
  if (
    typeof input.captureTimestamp === "number" &&
    Number.isFinite(input.captureTimestamp) &&
    input.captureTimestamp >= 0
  ) {
    capture.captureTimestamp = input.captureTimestamp;
  }
  return capture;
}

export interface MemoryMarkdownFrontmatter extends MemoryCaptureMetadata {
  id?: string;
  type?: string;
  tags?: string[];
  containerTag?: string;
  createdAt?: number;
  updatedAt?: number;
  source?: string;
  title?: string;
  [key: string]: unknown;
}

export interface ParsedMemoryMarkdown {
  frontmatter: MemoryMarkdownFrontmatter;
  body: string;
  /** True when the file had a YAML frontmatter fence. */
  hasFrontmatter: boolean;
}

export interface PackMemoryMarkdownInput extends MemoryCaptureMetadata {
  id: string;
  content: string;
  type?: string;
  tags?: string[];
  containerTag?: string;
  createdAt?: number;
  updatedAt?: number;
  source?: string;
  title?: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function yamlScalar(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return '""';
  return JSON.stringify(String(value));
}

function parseYamlScalar(raw: string): string | number | boolean {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed.replace(/^'/, '"').replace(/'$/, '"')) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  return trimmed;
}

function parseTagsValue(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed.replace(/'/g, '"')) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((t) => String(t).trim()).filter(Boolean);
      }
    } catch {
      /* fall through */
    }
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((t) => t.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  if (!trimmed) return [];
  return trimmed
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** Pack a memory into Markdown with YAML frontmatter (Skills-style). */
export function packMemoryMarkdown(input: PackMemoryMarkdownInput): string {
  const lines = ["---", `id: ${yamlScalar(input.id)}`];
  if (input.type) lines.push(`type: ${yamlScalar(input.type)}`);
  if (input.tags && input.tags.length > 0) {
    lines.push(`tags: ${JSON.stringify(input.tags)}`);
  }
  if (input.containerTag) lines.push(`containerTag: ${yamlScalar(input.containerTag)}`);
  if (input.createdAt !== undefined) lines.push(`createdAt: ${input.createdAt}`);
  if (input.updatedAt !== undefined) lines.push(`updatedAt: ${input.updatedAt}`);
  if (input.source) lines.push(`source: ${yamlScalar(input.source)}`);
  if (input.title) lines.push(`title: ${yamlScalar(input.title)}`);
  const capture = readCaptureMetadata({ ...input });
  if (capture.promptId) lines.push(`promptId: ${yamlScalar(capture.promptId)}`);
  if (capture.sessionID) lines.push(`sessionID: ${yamlScalar(capture.sessionID)}`);
  if (capture.captureTimestamp !== undefined) {
    lines.push(`captureTimestamp: ${capture.captureTimestamp}`);
  }
  lines.push("---", "", input.content);
  return lines.join("\n");
}

/** Parse Markdown with optional YAML frontmatter. */
export function parseMemoryMarkdown(raw: string): ParsedMemoryMarkdown {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    return { frontmatter: {}, body: raw, hasFrontmatter: false };
  }

  const yamlBlock = match[1] ?? "";
  const bodyRaw = match[2] ?? "";
  const frontmatter: MemoryMarkdownFrontmatter = {};
  for (const line of yamlBlock.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const valueRaw = trimmed.slice(colon + 1).trim();
    if (!key) continue;

    if (key === "tags") {
      frontmatter.tags = parseTagsValue(valueRaw);
      continue;
    }
    if (key === "createdAt" || key === "updatedAt") {
      const n = Number(valueRaw);
      if (Number.isFinite(n)) frontmatter[key] = n;
      continue;
    }
    const parsed = parseYamlScalar(valueRaw);
    if (key === "promptId" || key === "sessionID" || key === "captureTimestamp") {
      Object.assign(frontmatter, readCaptureMetadata({ [key]: parsed }));
    } else {
      frontmatter[key] = parsed;
    }
  }

  return {
    frontmatter,
    body: bodyRaw.replace(/^\r?\n/, ""),
    hasFrontmatter: true,
  };
}

/** Stable id for vault notes without an explicit frontmatter id. */
export function markdownIdFromRelPath(relPath: string): string {
  const hash = createHash("sha256").update(relPath.replace(/\\/g, "/")).digest("hex").slice(0, 16);
  return `md_${hash}`;
}

export function titleFromRelPath(relPath: string): string {
  const base = basename(relPath).replace(/\.md$/i, "");
  return base || relPath;
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
