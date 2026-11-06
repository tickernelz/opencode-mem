import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const IGNORED_DIR_NAMES = new Set([
  ".obsidian",
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  ".trash",
  ".DS_Store",
]);

export interface VaultFileInfo {
  /** Path relative to vault root, using forward slashes. */
  relPath: string;
  absPath: string;
  mtimeMs: number;
  size: number;
}

export interface VaultScanResult {
  files: VaultFileInfo[];
  /** A partial inventory must never be used to infer that memories were deleted. */
  errors: Array<{ path: string; error: string }>;
}

function normalizeRel(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function assertInsideVault(vaultRoot: string, candidateAbs: string): string {
  const root = resolve(vaultRoot);
  const abs = resolve(candidateAbs);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Refusing path outside markdownPath: ${candidateAbs}`);
  }
  return abs;
}

export function absPathForRel(vaultRoot: string, relPath: string): string {
  const normalized = normalizeRel(relPath);
  if (!normalized || normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error(`Invalid vault relative path: ${relPath}`);
  }
  return assertInsideVault(vaultRoot, join(resolve(vaultRoot), ...normalized.split("/")));
}

export function ensureVaultDir(vaultRoot: string): void {
  const root = resolve(vaultRoot);
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  const st = statSync(root);
  if (!st.isDirectory()) {
    throw new Error(`markdownPath is not a directory: ${root}`);
  }
}

function shouldSkipDir(name: string): boolean {
  if (IGNORED_DIR_NAMES.has(name)) return true;
  if (name.startsWith(".") && name !== ".") return true;
  return false;
}

export function scanMarkdownVault(vaultRoot: string): VaultScanResult {
  const root = resolve(vaultRoot);
  const out: VaultFileInfo[] = [];
  const errors: VaultScanResult["errors"] = [];

  function recordError(absPath: string, error: unknown): void {
    errors.push({
      path: normalizeRel(relative(root, absPath)) || ".",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      recordError(dir, error);
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      let st;
      try {
        st = statSync(abs);
        if (!st.isFile()) throw new Error("Markdown file is no longer a regular file");
      } catch (error) {
        recordError(abs, error);
        continue;
      }
      const rel = normalizeRel(relative(root, abs));
      out.push({
        relPath: rel,
        absPath: abs,
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    }
  }

  walk(root);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { files: out, errors };
}

/** Best-effort listing for display; reconciliation must use the scan's errors too. */
export function listMarkdownFiles(vaultRoot: string): VaultFileInfo[] {
  return scanMarkdownVault(vaultRoot).files;
}

export function readVaultFile(vaultRoot: string, relPath: string): string {
  const abs = absPathForRel(vaultRoot, relPath);
  return readFileSync(abs, "utf-8");
}

export function writeVaultFile(vaultRoot: string, relPath: string, content: string): string {
  ensureVaultDir(vaultRoot);
  const abs = absPathForRel(vaultRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
  return abs;
}

export function deleteVaultFile(vaultRoot: string, relPath: string): boolean {
  const abs = absPathForRel(vaultRoot, relPath);
  if (!existsSync(abs)) return false;
  unlinkSync(abs);
  return true;
}

/** Flat plugin-owned memory filename under vault root. */
export function pluginMemoryRelPath(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${safe}.md`;
}

export function vaultRelFromAbs(vaultRoot: string, absPath: string): string {
  const abs = assertInsideVault(vaultRoot, absPath);
  return normalizeRel(relative(resolve(vaultRoot), abs));
}

export function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

/** True if path segment list would be skipped during listing. */
export function isIgnoredVaultSegment(name: string): boolean {
  return shouldSkipDir(name);
}

export function pathSep(): string {
  return sep;
}
