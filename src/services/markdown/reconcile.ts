import { CONFIG } from "../../config.js";
import { embeddingService } from "../embedding.js";
import { log } from "../logger.js";
import { extractScopeFromContainerTag } from "../memory-scope.js";
import { tursoConnectionManager } from "../turso/connection-manager.js";
import { ensureTursoReady } from "../turso/ready.js";
import { tursoShardManager } from "../turso/shard-manager.js";
import type { MemoryRecord } from "../turso/types.js";
import { tursoVectorSearch } from "../turso/vector-search.js";
import { formatTagsForEmbedding } from "../turso/vector-utils.js";
import {
  contentHash,
  markdownIdFromRelPath,
  parseMemoryMarkdown,
  titleFromRelPath,
} from "./document.js";
import {
  listMarkdownFiles,
  readVaultFile,
  scanMarkdownVault,
  type VaultFileInfo,
} from "./vault.js";

export interface ReconcileResult {
  scanned: number;
  upserted: number;
  unchanged: number;
  deleted: number;
  /** Missing files are not evidence of deletion when the inventory is unsafe. */
  deletionSkipped?: "empty-vault" | "incomplete-scan";
  errors: Array<{ path: string; error: string }>;
  finishedAt: number;
}

export interface VaultIndexEntry {
  id: string;
  relPath: string;
  title?: string;
  mtimeMs: number;
  source?: string;
  containerTag?: string;
}

let lastReconcileAt: number | null = null;

export function getLastReconcileAt(): number | null {
  return lastReconcileAt;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "string") return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function findMemoryAcrossShards(
  id: string
): Promise<{ shardId: number; dbPath: string; row: Record<string, unknown> } | null> {
  const projectShards = await tursoShardManager.getAllShards("project", "");
  const userShards = await tursoShardManager.getAllShards("user", "");
  for (const shard of [...projectShards, ...userShards]) {
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    const row = await tursoVectorSearch.getMemoryById(db, id);
    if (row) {
      return { shardId: shard.id, dbPath: shard.dbPath, row };
    }
  }
  return null;
}

async function deleteMemoryById(id: string): Promise<boolean> {
  const found = await findMemoryAcrossShards(id);
  if (!found) return false;
  const db = await tursoConnectionManager.getConnection(found.dbPath);
  const hardDeleted = await tursoVectorSearch.deleteVector(db, id);
  if (!hardDeleted) return false;
  await tursoShardManager.decrementVectorCount(found.shardId);
  return true;
}

async function resolveContainerTag(fmContainerTag: string | undefined): Promise<string> {
  if (fmContainerTag && typeof fmContainerTag === "string" && fmContainerTag.trim()) {
    return fmContainerTag.trim();
  }
  // Lazy import: many subprocess tests mock tags.js with a partial export surface.
  const { getUserTagInfo } = await import("../tags.js");
  return getUserTagInfo().tag;
}

async function upsertFromFile(
  file: VaultFileInfo,
  raw: string,
  parsed = parseMemoryMarkdown(raw)
): Promise<"upserted" | "unchanged"> {
  const fm = parsed.frontmatter;

  const id =
    typeof fm.id === "string" && fm.id.trim() ? fm.id.trim() : markdownIdFromRelPath(file.relPath);
  const body = parsed.body.trim() ? parsed.body : raw;
  const content = body.trim();
  if (!content) {
    throw new Error("empty markdown body");
  }

  const hash = contentHash(raw);
  const existing = await findMemoryAcrossShards(id);
  if (existing) {
    const meta = parseMetadata(existing.row.metadata);
    if (
      meta.markdownContentHash === hash &&
      meta.markdownRelPath === file.relPath &&
      String(existing.row.content) === content
    ) {
      return "unchanged";
    }
  }

  const tags = Array.isArray(fm.tags) ? fm.tags.map((t) => String(t).trim()).filter(Boolean) : [];
  const containerTag = await resolveContainerTag(
    typeof fm.containerTag === "string" ? fm.containerTag : undefined
  );
  const title =
    typeof fm.title === "string" && fm.title.trim()
      ? fm.title.trim()
      : typeof fm.name === "string" && String(fm.name).trim()
        ? String(fm.name).trim()
        : titleFromRelPath(file.relPath);
  const source =
    typeof fm.source === "string" && fm.source.trim()
      ? fm.source.trim()
      : typeof fm.id === "string" && fm.id.trim()
        ? "markdown"
        : "markdown-import";
  const now = Date.now();
  const createdAt =
    typeof fm.createdAt === "number" && Number.isFinite(fm.createdAt) ? fm.createdAt : now;
  const updatedAt =
    typeof fm.updatedAt === "number" && Number.isFinite(fm.updatedAt) ? fm.updatedAt : now;
  const type = typeof fm.type === "string" && fm.type.trim() ? fm.type.trim() : undefined;

  const vector = await embeddingService.embedWithTimeout(content, { task: "document" });
  let tagsVector: Float32Array | undefined;
  if (tags.length > 0) {
    tagsVector = await embeddingService.embedWithTimeout(formatTagsForEmbedding(tags), {
      task: "document",
    });
  }

  const metadata = JSON.stringify({
    source,
    markdownRelPath: file.relPath,
    markdownContentHash: hash,
    markdownMtimeMs: file.mtimeMs,
    title,
  });

  const record: MemoryRecord = {
    id,
    content,
    vector,
    tagsVector,
    containerTag,
    tags: tags.length > 0 ? tags.join(",") : undefined,
    type,
    createdAt,
    updatedAt,
    metadata,
    displayName: title,
  };

  const { scope, hash: scopeHash } = extractScopeFromContainerTag(containerTag);

  await tursoShardManager.withScopeWriteLock(scope, scopeHash, async () => {
    if (existing) {
      const db = await tursoConnectionManager.getConnection(existing.dbPath);
      // Same id may live on a different shard if containerTag changed — delete old first.
      await tursoVectorSearch.deleteVector(db, id);
      await tursoShardManager.decrementVectorCount(existing.shardId);
    }

    const shard = await tursoShardManager.getWriteShard(scope, scopeHash);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    // If somehow still present on write shard (same shard path), remove before insert.
    const stillThere = await tursoVectorSearch.getMemoryById(db, id);
    if (stillThere) {
      await tursoVectorSearch.deleteVector(db, id);
      await tursoShardManager.decrementVectorCount(shard.id);
    }
    await tursoVectorSearch.insertVector(db, record);
    await tursoShardManager.incrementVectorCount(shard.id);
  });

  return "upserted";
}

async function collectIndexedMarkdownIds(): Promise<
  Map<string, { shardId: number; dbPath: string; relPath?: string }>
> {
  const map = new Map<string, { shardId: number; dbPath: string; relPath?: string }>();
  const projectShards = await tursoShardManager.getAllShards("project", "");
  const userShards = await tursoShardManager.getAllShards("user", "");
  for (const shard of [...projectShards, ...userShards]) {
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    const rows = await tursoVectorSearch.getAllMemories(db);
    for (const row of rows) {
      const id = String(row.id);
      const meta = parseMetadata(row.metadata);
      const relPath = typeof meta.markdownRelPath === "string" ? meta.markdownRelPath : undefined;
      // In markdown mode the vault is SoT: every indexed memory is treated as vault-backed.
      map.set(id, { shardId: shard.id, dbPath: shard.dbPath, relPath });
    }
  }
  return map;
}

export async function reconcileMarkdownVault(): Promise<ReconcileResult> {
  return reconcileVault();
}

/** A watcher deletion validates the whole inventory but only removes its own path. */
async function reconcileVault(deletedRelPath?: string): Promise<ReconcileResult> {
  const vaultRoot = CONFIG.markdownPath;
  if (!vaultRoot) {
    throw new Error("markdownPath is not configured");
  }

  await ensureTursoReady();
  await embeddingService.warmup();

  const { files, errors } = scanMarkdownVault(vaultRoot);
  const seenIds = new Set<string>();
  const result: ReconcileResult = {
    scanned: files.length,
    upserted: 0,
    unchanged: 0,
    deleted: 0,
    errors,
    finishedAt: Date.now(),
  };

  for (const file of files) {
    try {
      const raw = readVaultFile(vaultRoot, file.relPath);
      const parsed = parseMemoryMarkdown(raw);
      const id =
        typeof parsed.frontmatter.id === "string" && parsed.frontmatter.id.trim()
          ? parsed.frontmatter.id.trim()
          : markdownIdFromRelPath(file.relPath);
      seenIds.add(id);
      // Use the same snapshot for identity and content. A second read could see
      // a different id after an editor/sync write and delete the new row below.
      const outcome = await upsertFromFile(file, raw, parsed);
      if (outcome === "upserted") result.upserted++;
      else result.unchanged++;
    } catch (error) {
      result.errors.push({
        path: file.relPath,
        error: error instanceof Error ? error.message : String(error),
      });
      log("markdown reconcile file error", {
        path: file.relPath,
        error: String(error),
      });
    }
  }

  const indexed = await collectIndexedMarkdownIds();
  if (result.errors.length > 0) {
    result.deletionSkipped = "incomplete-scan";
  } else if (files.length === 0 && indexed.size > 0) {
    // An intentionally emptied vault cannot be distinguished from a missing
    // mount or incomplete sync. Explicit memory deletion remains available.
    result.deletionSkipped = "empty-vault";
  }

  if (result.deletionSkipped) {
    log("markdown reconcile warning: deletion skipped; existing index retained", {
      reason: result.deletionSkipped,
      path: vaultRoot,
      indexed: indexed.size,
      errors: result.errors,
    });
  } else {
    for (const [id, info] of indexed) {
      if (seenIds.has(id)) continue;
      if (
        deletedRelPath !== undefined &&
        info.relPath !== deletedRelPath &&
        id !== markdownIdFromRelPath(deletedRelPath)
      ) {
        continue;
      }
      try {
        const deleted = await deleteMemoryById(id);
        if (deleted) result.deleted++;
      } catch (error) {
        result.errors.push({
          path: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  lastReconcileAt = result.finishedAt;
  log("markdown reconcile complete", {
    scanned: result.scanned,
    upserted: result.upserted,
    unchanged: result.unchanged,
    deleted: result.deleted,
    deletionSkipped: result.deletionSkipped,
    errors: result.errors.length,
  });
  return result;
}

export async function listVaultIndexEntries(): Promise<VaultIndexEntry[]> {
  const vaultRoot = CONFIG.markdownPath;
  if (!vaultRoot) return [];

  const files = listMarkdownFiles(vaultRoot);
  const entries: VaultIndexEntry[] = [];

  for (const file of files) {
    try {
      const raw = readVaultFile(vaultRoot, file.relPath);
      const parsed = parseMemoryMarkdown(raw);
      const fm = parsed.frontmatter;
      const id =
        typeof fm.id === "string" && fm.id.trim()
          ? fm.id.trim()
          : markdownIdFromRelPath(file.relPath);
      const title =
        typeof fm.title === "string" && fm.title.trim()
          ? fm.title.trim()
          : typeof fm.name === "string" && String(fm.name).trim()
            ? String(fm.name).trim()
            : titleFromRelPath(file.relPath);
      entries.push({
        id,
        relPath: file.relPath,
        title,
        mtimeMs: file.mtimeMs,
        source:
          typeof fm.source === "string"
            ? fm.source
            : typeof fm.id === "string"
              ? "markdown"
              : "markdown-import",
        containerTag: typeof fm.containerTag === "string" ? fm.containerTag : undefined,
      });
    } catch {
      entries.push({
        id: markdownIdFromRelPath(file.relPath),
        relPath: file.relPath,
        mtimeMs: file.mtimeMs,
      });
    }
  }

  return entries;
}

export async function reindexVaultFile(relPath: string): Promise<void> {
  const vaultRoot = CONFIG.markdownPath;
  if (!vaultRoot) throw new Error("markdownPath is not configured");
  await ensureTursoReady();
  await embeddingService.warmup();
  const { files } = scanMarkdownVault(vaultRoot);
  const file = files.find((f) => f.relPath === relPath);
  if (!file) {
    // Watcher events also arrive when the vault disappears or cannot be read.
    // Require the same complete, nonempty inventory as a full reconciliation.
    // This also preserves an explicit id when a file was renamed in the vault.
    await reconcileVault(relPath);
    return;
  }
  await upsertFromFile(file, readVaultFile(vaultRoot, file.relPath));
}
