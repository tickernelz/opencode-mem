import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TursoDb } from "./turso-db.js";
import { log } from "../../infra/logger.js";
import { withSqliteFileLockRetry, copySqliteDatabase } from "./sqlite-handle-release.js";

export type SchemaMigration = {
  version: number;
  description: string;
  statements: Array<{ sql: string; args?: Array<string | number | null> }>;
};

async function getUserVersion(db: TursoDb): Promise<number> {
  const row = await db.get<{ user_version?: number }>(`PRAGMA user_version`);
  return Number(row?.user_version ?? 0);
}

async function setUserVersion(db: TursoDb, version: number): Promise<void> {
  await db.run(`PRAGMA user_version = ${Math.trunc(version)}`);
}

function backupBeforeDestructive(dbPath: string | undefined, fromVersion: number): string | null {
  if (!dbPath || !existsSync(dbPath) || fromVersion <= 0) return null;
  const backupPath = `${dbPath}.schema-v${fromVersion}-${Date.now()}.bak`;
  const dir = dirname(backupPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  copySqliteDatabase(dbPath, backupPath);
  return backupPath;
}

export async function applySchemaMigrations(
  db: TursoDb,
  migrations: SchemaMigration[],
  options?: { dbPath?: string; label?: string }
): Promise<number> {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const current = await getUserVersion(db);
  const pending = sorted.filter((migration) => migration.version > current);
  if (pending.length === 0) return current;

  const target = pending[pending.length - 1]!.version;
  const backupPath = backupBeforeDestructive(options?.dbPath, current);
  if (backupPath) {
    log("Schema migration backup created", {
      label: options?.label,
      from: current,
      to: target,
      backupPath,
    });
  }

  try {
    for (const migration of pending) {
      await db.batch(migration.statements, "write");
      await setUserVersion(db, migration.version);
      log("Applied schema migration", {
        label: options?.label,
        version: migration.version,
        description: migration.description,
      });
    }
    return target;
  } catch (error) {
    if (backupPath && options?.dbPath) {
      try {
        await db.close();
      } catch {
        // ignore
      }
      await withSqliteFileLockRetry(() => {
        if (existsSync(options.dbPath!)) unlinkSync(options.dbPath!);
        renameSync(backupPath, options.dbPath!);
      });
    }
    throw error;
  }
}

/** Memory shard schema without DiskANN indexes (exact cosine search). */
export function memoryShardMigrations(dimensions: number): SchemaMigration[] {
  const dims = Math.trunc(dimensions);
  return [
    {
      version: 1,
      description: "Baseline memories + shard_metadata for @tursodatabase/database",
      statements: [
        {
          sql: `
            CREATE TABLE IF NOT EXISTS shard_metadata (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            )
          `,
        },
        {
          sql: `
            CREATE TABLE IF NOT EXISTS memories (
              id TEXT PRIMARY KEY,
              content TEXT NOT NULL,
              vector F32_BLOB(${dims}) NOT NULL,
              tags_vector F32_BLOB(${dims}),
              container_tag TEXT NOT NULL,
              tags TEXT,
              type TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              metadata TEXT,
              display_name TEXT,
              user_name TEXT,
              user_email TEXT,
              project_path TEXT,
              project_name TEXT,
              git_repo_url TEXT,
              is_pinned INTEGER DEFAULT 0
            )
          `,
        },
        { sql: `CREATE INDEX IF NOT EXISTS idx_container_tag ON memories(container_tag)` },
        { sql: `CREATE INDEX IF NOT EXISTS idx_type ON memories(type)` },
        { sql: `CREATE INDEX IF NOT EXISTS idx_created_at ON memories(created_at DESC)` },
        { sql: `CREATE INDEX IF NOT EXISTS idx_is_pinned ON memories(is_pinned)` },
      ],
    },
    {
      version: 2,
      description:
        "Indexed session_id for session lookup (FTS5 unavailable on @tursodatabase/database)",
      statements: [
        { sql: `ALTER TABLE memories ADD COLUMN session_id TEXT` },
        { sql: `CREATE INDEX IF NOT EXISTS idx_session_id ON memories(session_id)` },
        {
          sql: `
            UPDATE memories
            SET session_id = json_extract(metadata, '$.sessionID')
            WHERE metadata IS NOT NULL
              AND session_id IS NULL
              AND json_extract(metadata, '$.sessionID') IS NOT NULL
          `,
        },
      ],
    },
  ];
}

export const METADATA_DB_MIGRATIONS: SchemaMigration[] = [
  {
    version: 1,
    description: "Baseline shards registry",
    statements: [
      {
        sql: `
          CREATE TABLE IF NOT EXISTS shards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope TEXT NOT NULL,
            scope_hash TEXT NOT NULL,
            shard_index INTEGER NOT NULL,
            db_path TEXT NOT NULL,
            vector_count INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            created_at INTEGER NOT NULL,
            UNIQUE(scope, scope_hash, shard_index)
          )
        `,
      },
      {
        sql: `
          CREATE INDEX IF NOT EXISTS idx_active_shards
          ON shards(scope, scope_hash, is_active)
        `,
      },
    ],
  },
];

export const USER_PROMPTS_MIGRATIONS: SchemaMigration[] = [
  {
    version: 1,
    description: "Baseline user_prompts with provider/model columns",
    statements: [
      {
        sql: `
          CREATE TABLE IF NOT EXISTS user_prompts (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            project_path TEXT,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            captured INTEGER DEFAULT 0,
            user_learning_captured BOOLEAN DEFAULT 0,
            linked_memory_id TEXT,
            capture_attempts INTEGER DEFAULT 0,
            provider_id TEXT,
            model_id TEXT
          )
        `,
      },
      { sql: "CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_id)" },
      { sql: "CREATE INDEX IF NOT EXISTS idx_user_prompts_captured ON user_prompts(captured)" },
      {
        sql: "CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at DESC)",
      },
      { sql: "CREATE INDEX IF NOT EXISTS idx_user_prompts_project ON user_prompts(project_path)" },
      {
        sql: "CREATE INDEX IF NOT EXISTS idx_user_prompts_linked ON user_prompts(linked_memory_id)",
      },
      {
        sql: "CREATE INDEX IF NOT EXISTS idx_user_prompts_user_learning ON user_prompts(user_learning_captured)",
      },
    ],
  },
];

export const USER_PROFILES_MIGRATIONS: SchemaMigration[] = [
  {
    version: 1,
    description: "Baseline user_profiles + changelogs",
    statements: [
      {
        sql: `
          CREATE TABLE IF NOT EXISTS user_profiles (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            user_name TEXT NOT NULL,
            user_email TEXT NOT NULL,
            profile_data TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            last_analyzed_at INTEGER NOT NULL,
            total_prompts_analyzed INTEGER NOT NULL DEFAULT 0,
            is_active BOOLEAN NOT NULL DEFAULT 1
          )
        `,
      },
      {
        sql: `
          CREATE TABLE IF NOT EXISTS user_profile_changelogs (
            id TEXT PRIMARY KEY,
            profile_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            change_type TEXT NOT NULL,
            change_summary TEXT NOT NULL,
            profile_data_snapshot TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (profile_id) REFERENCES user_profiles(id) ON DELETE CASCADE
          )
        `,
      },
      { sql: "CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id)" },
      {
        sql: "CREATE INDEX IF NOT EXISTS idx_user_profiles_is_active ON user_profiles(is_active)",
      },
      {
        sql: "CREATE INDEX IF NOT EXISTS idx_user_profile_changelogs_profile_id ON user_profile_changelogs(profile_id)",
      },
      {
        sql: "CREATE INDEX IF NOT EXISTS idx_user_profile_changelogs_version ON user_profile_changelogs(version DESC)",
      },
    ],
  },
];

export const AI_SESSIONS_MIGRATIONS: SchemaMigration[] = [
  {
    version: 1,
    description: "Baseline ai_sessions + ai_messages",
    statements: [
      {
        sql: `
          CREATE TABLE IF NOT EXISTS ai_sessions (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            session_id TEXT NOT NULL,
            conversation_id TEXT,
            metadata TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
          )
        `,
      },
      { sql: "CREATE INDEX IF NOT EXISTS idx_ai_sessions_session_id ON ai_sessions(session_id)" },
      { sql: "CREATE INDEX IF NOT EXISTS idx_ai_sessions_expires_at ON ai_sessions(expires_at)" },
      { sql: "CREATE INDEX IF NOT EXISTS idx_ai_sessions_provider ON ai_sessions(provider)" },
      {
        sql: `
          CREATE TABLE IF NOT EXISTS ai_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ai_session_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            tool_calls TEXT,
            tool_call_id TEXT,
            content_blocks TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (ai_session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
          )
        `,
      },
      {
        sql: "CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_messages(ai_session_id, sequence)",
      },
      {
        sql: "CREATE INDEX IF NOT EXISTS idx_ai_messages_role ON ai_messages(ai_session_id, role)",
      },
    ],
  },
];

/** After CREATE IF NOT EXISTS on older prompt DBs, ensure new columns exist. */
export async function ensureUserPromptColumns(db: TursoDb): Promise<void> {
  for (const column of [
    "capture_attempts INTEGER DEFAULT 0",
    "provider_id TEXT",
    "model_id TEXT",
  ]) {
    try {
      await db.run(`ALTER TABLE user_prompts ADD COLUMN ${column}`);
    } catch (error: unknown) {
      const message = String((error as { message?: string })?.message ?? error);
      if (!message.includes("duplicate column")) {
        log("Failed to add user_prompts column", { column, error: message });
      }
    }
  }
}

export function migrationMarkerPath(storagePath: string): string {
  return join(storagePath, ".schema-migrations-v1");
}
