import { mkdirSync } from "node:fs";
import { CONFIG } from "../../config.js";
import { log } from "../logger.js";
import { packMemoryMarkdown, type MemoryCaptureMetadata } from "./document.js";
import {
  getLastReconcileAt,
  listVaultIndexEntries,
  reconcileMarkdownVault,
  type ReconcileResult,
  type VaultIndexEntry,
} from "./reconcile.js";
import {
  deleteVaultFile,
  ensureVaultDir,
  listMarkdownFiles,
  pluginMemoryRelPath,
  writeVaultFile,
} from "./vault.js";
import { markdownVaultWatcher } from "./watcher.js";

export interface MarkdownMemoryWriteInput extends MemoryCaptureMetadata {
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

export interface MarkdownStatus {
  enabled: boolean;
  path: string | null;
  fileCount: number;
  lastReconcileAt: number | null;
  watcherActive: boolean;
  files: VaultIndexEntry[];
}

export function isMarkdownBackend(): boolean {
  return CONFIG.memoryBackend === "markdown" && !!CONFIG.markdownPath;
}

export function getMarkdownPath(): string | null {
  return isMarkdownBackend() ? (CONFIG.markdownPath ?? null) : null;
}

/** Write plugin-owned memory file before indexing. */
export function writeMemoryMarkdownFile(input: MarkdownMemoryWriteInput): string {
  const root = getMarkdownPath();
  if (!root) throw new Error("markdown backend is not enabled");
  ensureVaultDir(root);
  const relPath = pluginMemoryRelPath(input.id);
  const markdown = packMemoryMarkdown({
    id: input.id,
    content: input.content,
    type: input.type,
    tags: input.tags,
    containerTag: input.containerTag,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    source: input.source,
    title: input.title,
    promptId: input.promptId,
    sessionID: input.sessionID,
    captureTimestamp: input.captureTimestamp,
  });
  markdownVaultWatcher.noteSelfWrite(relPath);
  writeVaultFile(root, relPath, markdown);
  return relPath;
}

/**
 * Delete the vault file for a memory. Prefers `metadata.markdownRelPath` when
 * provided (imported wiki pages); otherwise falls back to `{id}.md`.
 */
export function deleteMemoryMarkdownFile(id: string, markdownRelPath?: string | null): boolean {
  const root = getMarkdownPath();
  if (!root) return false;
  const relPath =
    typeof markdownRelPath === "string" && markdownRelPath.trim()
      ? markdownRelPath.trim().replace(/\\/g, "/")
      : pluginMemoryRelPath(id);
  markdownVaultWatcher.noteSelfWrite(relPath);
  return deleteVaultFile(root, relPath);
}

export async function startMarkdownBackend(): Promise<ReconcileResult | null> {
  if (!isMarkdownBackend()) return null;
  const root = CONFIG.markdownPath!;
  try {
    mkdirSync(root, { recursive: true });
    ensureVaultDir(root);
  } catch (error) {
    log("markdown backend: failed to ensure vault dir", { error: String(error), root });
    throw error;
  }

  const result = await reconcileMarkdownVault();
  markdownVaultWatcher.start(root);
  return result;
}

export function stopMarkdownBackend(): void {
  markdownVaultWatcher.stop();
}

export async function getMarkdownStatus(): Promise<MarkdownStatus> {
  const enabled = isMarkdownBackend();
  const path = getMarkdownPath();
  if (!enabled || !path) {
    return {
      enabled: false,
      path: null,
      fileCount: 0,
      lastReconcileAt: null,
      watcherActive: false,
      files: [],
    };
  }

  let files: VaultIndexEntry[];
  try {
    files = await listVaultIndexEntries();
  } catch (error) {
    log("markdown status list failed", { error: String(error) });
    files = listMarkdownFiles(path).map((f) => ({
      id: f.relPath,
      relPath: f.relPath,
      mtimeMs: f.mtimeMs,
    }));
  }

  return {
    enabled: true,
    path,
    fileCount: files.length,
    lastReconcileAt: getLastReconcileAt(),
    watcherActive: markdownVaultWatcher.active,
    files,
  };
}

export async function reindexMarkdownVault(): Promise<ReconcileResult> {
  if (!isMarkdownBackend()) {
    throw new Error("markdown backend is not enabled");
  }
  return reconcileMarkdownVault();
}
