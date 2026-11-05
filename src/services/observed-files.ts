import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { sanitizeMemoryContent } from "./privacy.js";

export const MAX_OBSERVED_FILES = 16;
export const MAX_OBSERVED_FILE_PATH_BYTES = 512;
const MAX_CANDIDATES = 64;
const MAX_SNAPSHOT_PARTS = 256;

export interface ObservedFiles {
  version: 1;
  /** Actual checkout identity, distinct from the project tag shared by worktrees. */
  workspace: string;
  paths: string[];
}

export interface ObservedFileContext {
  workspace: string;
  normalizeCandidates(candidates: readonly unknown[]): Promise<ObservedFiles | undefined>;
}

/** Internal V2 bridge capability; workspace drivers may use a remote filesystem. */
export function supportsLocalFileObservations(host: unknown): boolean {
  return object(host)?.fileObservationEnvironment !== "workspace";
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function cleanPathText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_OBSERVED_FILE_PATH_BYTES &&
    Buffer.byteLength(value, "utf8") <= MAX_OBSERVED_FILE_PATH_BYTES &&
    // Reject control characters in filenames before they can enter metadata.
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]/.test(value) &&
    !/\[REDACTED(?::[^\]]*)?\]/i.test(value) &&
    sanitizeMemoryContent(value) === value
  );
}

function safeInputPath(value: unknown): value is string {
  if (!cleanPathText(value)) return false;
  // OpenCode expands home and Windows shell drive shorthand before resolving
  // paths. Refuse those forms rather than associate a different literal path
  // under the checkout. Keep the rule conservative across platforms.
  if (/^~(?:[\\/]|$)/.test(value)) return false;
  if (/^[\\/](?:[a-z]:?|(?:cygdrive|mnt)[\\/][a-z])(?:[\\/]|$)/i.test(value)) return false;
  // Never reinterpret a foreign-platform path or URI as a local filename.
  if (sep === "/" && (value.includes("\\") || value.startsWith("//"))) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !(sep === "\\" && /^[a-z]:[\\/]/i.test(value)))
    return false;
  return !value.split(/[\\/]/).includes("..");
}

function safeRelativePath(value: unknown): value is string {
  return (
    cleanPathText(value) &&
    !value.includes("\\") &&
    !isAbsolute(value) &&
    !win32.isAbsolute(value) &&
    !/^[a-z][a-z0-9+.-]*:/i.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** Validate persisted/query metadata without touching the filesystem. */
export function isObservedFiles(value: unknown): value is ObservedFiles {
  const data = object(value);
  if (
    data?.version !== 1 ||
    typeof data.workspace !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.workspace) ||
    !Array.isArray(data.paths) ||
    data.paths.length === 0 ||
    data.paths.length > MAX_OBSERVED_FILES
  ) {
    return false;
  }
  return data.paths.every(safeRelativePath) && new Set(data.paths).size === data.paths.length;
}

/**
 * The V2 execute.after hook can call this synchronously. Only the narrow native
 * tool contract is accepted; no output text, shell command or patch is parsed.
 */
export function extractCompletedFilePath(event: unknown): string | undefined {
  const data = object(event);
  if (data?.status !== "completed" || !["read", "edit", "write"].includes(String(data.tool)))
    return undefined;
  if (data.tool === "read") {
    const output = object(object(data.result)?.output);
    if (output?.type !== "text-page" && output?.type !== "file") return undefined;
  }
  const path = object(data.input)?.path;
  return safeInputPath(path) ? path : undefined;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function hasRootMarker(directory: string): Promise<boolean> {
  for (const name of [".git", ".opencode-mem-project"]) {
    try {
      const marker = await lstat(join(directory, name));
      if (marker.isFile()) return true;
      // Empty sandbox guard directories named .git are not checkouts. Checking
      // HEAD's metadata also avoids treating an arbitrary empty folder as Git.
      if (name === ".git" && marker.isDirectory()) {
        const head = await lstat(join(directory, name, "HEAD"));
        if (head.isFile()) return true;
      }
    } catch {
      // Missing/inaccessible markers are not evidence of a root.
    }
  }
  return false;
}

/**
 * Resolve once per plugin instance. The nearest checkout/marker is deliberately
 * used instead of the common Git directory: different worktrees must not match.
 * No source contents are read. Filesystem checks occur at a model-context or
 * capture boundary, never inside the native tool-completion hook.
 */
export async function createObservedFileContext(
  directory: string
): Promise<ObservedFileContext | null> {
  let base: string;
  try {
    if (!isAbsolute(directory)) return null;
    base = await realpath(directory);
    if (!(await stat(base)).isDirectory()) return null;
  } catch {
    return null;
  }
  let root = base;
  for (let current = base; ; current = dirname(current)) {
    if (await hasRootMarker(current)) {
      root = current;
      break;
    }
    if (dirname(current) === current) break;
  }
  const workspace = createHash("sha256").update(root).digest("hex");

  return {
    workspace,
    async normalizeCandidates(candidates) {
      const paths = new Set<string>();
      const seen = new Set<string>();
      for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
        if (!safeInputPath(candidate)) continue;
        const absolute = resolve(base, candidate);
        if (!inside(root, absolute) || seen.has(absolute)) continue;
        seen.add(absolute);
        try {
          // Reject all symlink aliases below the canonical root, including
          // internal aliases. Otherwise a later retarget could recall a lesson
          // for a different file under the same stored relative path.
          if ((await realpath(absolute)) !== absolute) continue;
          if (!(await stat(absolute)).isFile()) continue;
        } catch {
          // Missing/renamed paths (including read's alternate-name fallback)
          // have no trustworthy association with the requested file.
          continue;
        }
        const path = relative(root, absolute).split(sep).join("/");
        if (!safeRelativePath(path)) continue;
        paths.add(path);
        if (paths.size === MAX_OBSERVED_FILES) break;
      }
      return paths.size ? { version: 1, workspace, paths: [...paths] } : undefined;
    },
  };
}

/**
 * Collect only V2 native tool snapshots from the already-delimited authored
 * turn. The V2 bridge preserves part.name and state.input.path. V1's filePath
 * contract is intentionally not guessed here. Bounded tail traversal prefers
 * the latest state of repeated snapshots and never inspects tool result text.
 */
export async function collectObservedFiles(
  messages: readonly unknown[],
  context: ObservedFileContext
): Promise<ObservedFiles | undefined> {
  const candidates: string[] = [];
  const seen = new Set<string>();
  let inspected = 0;
  for (
    let i = messages.length - 1;
    i >= Math.max(0, messages.length - MAX_SNAPSHOT_PARTS) && inspected < MAX_SNAPSHOT_PARTS;
    i--
  ) {
    const message = object(messages[i]);
    const info = object(message?.info);
    if (info?.role !== "assistant" || info.summary || typeof info.id !== "string") continue;
    const parts = message?.parts;
    if (!Array.isArray(parts)) continue;
    for (let j = parts.length - 1; j >= 0 && inspected < MAX_SNAPSHOT_PARTS; j--) {
      inspected++;
      const part = object(parts[j]);
      if (part?.type !== "tool" || typeof part.id !== "string") continue;
      const identity = JSON.stringify([info.id, part.id]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const state = object(part.state);
      if (
        part.synthetic ||
        part.ignored ||
        state?.status !== "completed" ||
        !["read", "edit", "write"].includes(String(part.name))
      ) {
        continue;
      }
      const path = object(state.input)?.path;
      if (safeInputPath(path) && !candidates.includes(path)) candidates.push(path);
      if (candidates.length === MAX_CANDIDATES) return context.normalizeCandidates(candidates);
    }
  }
  return context.normalizeCandidates(candidates);
}
