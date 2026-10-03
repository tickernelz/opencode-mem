import { connect } from "@tursodatabase/database";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../../config.js";
import { log } from "../../infra/logger.js";
import {
  resolveDatabaseEncryption,
  tursoConnectionManager,
  buildConnectOptions,
} from "./connection-manager.js";
import { acquireTursoOperationLock } from "./operation-lock.js";
import {
  withSqliteFileLockRetry,
  renameSqliteDatabase,
  copySqliteDatabase,
  removeSqliteDatabase,
} from "./sqlite-handle-release.js";
import { TursoDb, type SqlValue } from "./turso-db.js";
import { tursoShardManager } from "./shard-manager.js";

const ENCRYPT_MARKER = ".tursodb-encrypted-v1";

function asSqlValue(value: unknown): SqlValue {
  if (value == null) return null;
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return value;
  return String(value);
}

function markerPath(): string {
  return join(CONFIG.storagePath, ENCRYPT_MARKER);
}

function listDbFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".db") && !name.includes(".bak") && !name.includes(".tmp"))
    .map((name) => join(dir, name));
}

function collectCandidateDbs(): string[] {
  const root = CONFIG.storagePath;
  return [
    ...listDbFiles(root),
    ...listDbFiles(join(root, "users")),
    ...listDbFiles(join(root, "projects")),
  ];
}

async function isAlreadyEncrypted(dbPath: string): Promise<boolean> {
  const encryption = resolveDatabaseEncryption();
  if (!encryption) return false;
  try {
    const db = await connect(dbPath, buildConnectOptions(encryption));
    await db.close();
    return true;
  } catch {
    return false;
  }
}

async function canOpenPlain(dbPath: string): Promise<boolean> {
  try {
    const db = await connect(dbPath, buildConnectOptions());
    await db.close();
    return true;
  } catch {
    return false;
  }
}

async function dumpAndReloadEncrypted(dbPath: string): Promise<void> {
  const encryption = resolveDatabaseEncryption();
  if (!encryption) {
    throw new Error("databaseEncryptionKey is required for encryption migration");
  }

  await tursoConnectionManager.closeConnection(dbPath);

  const stagedPath = `${dbPath}.encrypt-${Date.now()}.tmp`;
  const backupPath = `${dbPath}.pre-encrypt-${Date.now()}.bak`;

  // Re-open plain to copy rows into encrypted staged DB.
  const source = await connect(dbPath, buildConnectOptions());
  const sourceDb = new TursoDb(source);
  const staged = await connect(stagedPath, buildConnectOptions(encryption));
  const stagedDb = new TursoDb(staged);

  try {
    const tables = await sourceDb.all<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '__turso_internal_%'
         AND name NOT LIKE '%_fts%'
         AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'`
    );
    const tableNames = tables.map((row) => String(row.name));
    for (const table of tableNames) {
      const create = await sourceDb.get<{ sql?: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [table]
      );
      if (!create?.sql) continue;
      await stagedDb.run(String(create.sql));

      if (table === "memories") {
        const rows = await sourceDb.all(`
          SELECT
            id, content,
            vector_extract(vector) AS vector,
            CASE WHEN tags_vector IS NOT NULL THEN vector_extract(tags_vector) ELSE NULL END AS tags_vector,
            container_tag, tags, type, created_at, updated_at, metadata,
            display_name, user_name, user_email, project_path, project_name, git_repo_url, is_pinned
          FROM memories
        `);
        for (const row of rows) {
          if (row.tags_vector == null) {
            await stagedDb.run(
              `INSERT OR REPLACE INTO memories (
                id, content, vector, tags_vector, container_tag, tags, type, created_at, updated_at,
                metadata, display_name, user_name, user_email, project_path, project_name, git_repo_url, is_pinned
              ) VALUES (?, ?, vector32(?), NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                asSqlValue(row.id),
                asSqlValue(row.content),
                String(row.vector),
                asSqlValue(row.container_tag),
                asSqlValue(row.tags),
                asSqlValue(row.type),
                asSqlValue(row.created_at),
                asSqlValue(row.updated_at),
                asSqlValue(row.metadata),
                asSqlValue(row.display_name),
                asSqlValue(row.user_name),
                asSqlValue(row.user_email),
                asSqlValue(row.project_path),
                asSqlValue(row.project_name),
                asSqlValue(row.git_repo_url),
                asSqlValue(row.is_pinned ?? 0),
              ]
            );
          } else {
            await stagedDb.run(
              `INSERT OR REPLACE INTO memories (
                id, content, vector, tags_vector, container_tag, tags, type, created_at, updated_at,
                metadata, display_name, user_name, user_email, project_path, project_name, git_repo_url, is_pinned
              ) VALUES (?, ?, vector32(?), vector32(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                asSqlValue(row.id),
                asSqlValue(row.content),
                String(row.vector),
                String(row.tags_vector),
                asSqlValue(row.container_tag),
                asSqlValue(row.tags),
                asSqlValue(row.type),
                asSqlValue(row.created_at),
                asSqlValue(row.updated_at),
                asSqlValue(row.metadata),
                asSqlValue(row.display_name),
                asSqlValue(row.user_name),
                asSqlValue(row.user_email),
                asSqlValue(row.project_path),
                asSqlValue(row.project_name),
                asSqlValue(row.git_repo_url),
                asSqlValue(row.is_pinned ?? 0),
              ]
            );
          }
        }
        continue;
      }

      const rows = await sourceDb.all(`SELECT * FROM ${table}`);
      if (rows.length === 0) continue;
      const columns = Object.keys(rows[0]!);
      const placeholders = columns.map(() => "?").join(", ");
      for (const row of rows) {
        await stagedDb.run(
          `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
          columns.map((col) => asSqlValue(row[col]))
        );
      }
    }

    const indexes = await sourceDb.all<{ sql?: string }>(
      `SELECT sql FROM sqlite_master
       WHERE type = 'index'
         AND sql IS NOT NULL
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '__turso_internal_%'`
    );
    for (const index of indexes) {
      if (!index.sql) continue;
      try {
        await stagedDb.run(String(index.sql));
      } catch {
        // may already exist
      }
    }
  } finally {
    await sourceDb.close();
    await stagedDb.close();
  }

  await withSqliteFileLockRetry(() => {
    copySqliteDatabase(dbPath, backupPath);
    removeSqliteDatabase(dbPath);
    renameSqliteDatabase(stagedPath, dbPath);
  });

  // Verify encrypted open
  const verify = await connect(dbPath, buildConnectOptions(encryption));
  await verify.close();

  log("Encrypted database at rest", { dbPath, backupPath });
}

/**
 * When database encryption is enabled (or a key is configured), convert
 * plaintext shards to encrypted Turso DB files. No-op when encryption is off.
 */
export async function runDatabaseEncryptionMigration(): Promise<void> {
  const encryption = resolveDatabaseEncryption();
  if (!encryption) return;
  if (existsSync(markerPath())) return;

  const candidates = collectCandidateDbs();
  const release = acquireTursoOperationLock("tursodb-encrypt");
  try {
    for (const path of candidates) {
      if (await isAlreadyEncrypted(path)) continue;
      if (!(await canOpenPlain(path))) {
        throw new Error(
          `Cannot open ${path} as plaintext for encryption migration. ` +
            `If it is already encrypted with a different key, update databaseEncryptionKey.`
        );
      }
      await dumpAndReloadEncrypted(path);
    }
    writeFileSync(
      markerPath(),
      JSON.stringify({
        migratedAt: new Date().toISOString(),
        cipher: encryption.cipher,
      })
    );
  } finally {
    tursoShardManager.reset();
    release();
  }
}
