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
  readCaptureMetadata,
  titleFromRelPath,
} from "./document.js";
import { listMarkdownFiles, readVaultFile, type VaultFileInfo } from "./vault.js";

export interface ReconcileResult {
  scanned: number;
  upserted: number;
  unchanged: number;
  deleted: number;
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
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
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

async function upsertFromFile(file: VaultFileInfo): Promise<"upserted" | "unchanged"> {
  const raw = readVaultFile(CONFIG.markdownPath!, file.relPath);
  const parsed = parseMemoryMarkdown(raw);
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
  const existingMetadata = parseMetadata(existing?.row.metadata);
  if (existing) {
    if (
      existingMetadata.markdownContentHash === hash &&
      existingMetadata.markdownRelPath === file.relPath &&
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

  // Legacy vault files omit capture fields. Keep their surviving provenance and
  // other index-only metadata; validated file values take precedence when present.
  const capture = {
    ...readCaptureMetadata(existingMetadata),
    ...readCaptureMetadata(fm),
  };
  const metadata = JSON.stringify({
    ...existingMetadata,
    ...capture,
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
    sessionId:
      capture.sessionID ??
      (typeof existing?.row.session_id === "string" ? existing.row.session_id : undefined),
    displayName: title,
    userName: typeof existing?.row.user_name === "string" ? existing.row.user_name : undefined,
    userEmail: typeof existing?.row.user_email === "string" ? existing.row.user_email : undefined,
    projectPath:
      typeof existing?.row.project_path === "string" ? existing.row.project_path : undefined,
    projectName:
      typeof existing?.row.project_name === "string" ? existing.row.project_name : undefined,
    gitRepoUrl:
      typeof existing?.row.git_repo_url === "string" ? existing.row.git_repo_url : undefined,
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
    if (Number(existing?.row.is_pinned) === 1) {
      await tursoVectorSearch.pinMemory(db, id);
    }
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
  const vaultRoot = CONFIG.markdownPath;
  if (!vaultRoot) {
    throw new Error("markdownPath is not configured");
  }

  await ensureTursoReady();
  await embeddingService.warmup();

  const files = listMarkdownFiles(vaultRoot);
  const seenIds = new Set<string>();
  const result: ReconcileResult = {
    scanned: files.length,
    upserted: 0,
    unchanged: 0,
    deleted: 0,
    errors: [],
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
      const outcome = await upsertFromFile(file);
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
  for (const [id] of indexed) {
    if (seenIds.has(id)) continue;
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

  lastReconcileAt = result.finishedAt;
  log("markdown reconcile complete", {
    scanned: result.scanned,
    upserted: result.upserted,
    unchanged: result.unchanged,
    deleted: result.deleted,
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
  const files = listMarkdownFiles(vaultRoot);
  const file = files.find((f) => f.relPath === relPath);
  if (!file) {
    // File gone — drop any id derived from path or previously stored for this path.
    const indexed = await collectIndexedMarkdownIds();
    for (const [id, info] of indexed) {
      if (info.relPath === relPath || id === markdownIdFromRelPath(relPath)) {
        await deleteMemoryById(id);
      }
    }
    return;
  }
  await upsertFromFile(file);
}
