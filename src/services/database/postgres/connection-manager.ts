import pg from "pg";
import pgvector from "pgvector/pg";
import { CONFIG } from "../../../config.js";
import { log } from "../../logger.js";

const { Pool } = pg;

export class ConnectionManager {
  private pool: pg.Pool | null = null;
  private initialized = false;

  async getPool(): Promise<pg.Pool> {
    if (this.pool) {
      return this.pool;
    }

    if (!CONFIG.databaseUrl) {
      throw new Error(
        "DATABASE_URL is not configured.\n" +
          "Please set the DATABASE_URL environment variable or configure databaseUrl in ~/.config/opencode/opencode-memory.jsonc"
      );
    }

    this.pool = new Pool({
      connectionString: CONFIG.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    this.pool.on("error", (err) => {
      log("Unexpected PostgreSQL pool error", { error: String(err) });
    });

    await this.initSchema();

    return this.pool;
  }

  private async initSchema(): Promise<void> {
    if (this.initialized || !this.pool) return;

    const client = await this.pool.connect();
    try {
      await pgvector.registerTypes(client);

      await client.query("CREATE EXTENSION IF NOT EXISTS vector");

      await client.query(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          embedding vector(${CONFIG.embeddingDimensions}),
          tags_embedding vector(${CONFIG.embeddingDimensions}),
          container_tag VARCHAR(255) NOT NULL,
          tags TEXT,
          type VARCHAR(50),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          metadata JSONB,
          display_name VARCHAR(255),
          user_name VARCHAR(255),
          user_email VARCHAR(255),
          project_path TEXT,
          project_name VARCHAR(255),
          git_repo_url TEXT,
          is_pinned BOOLEAN DEFAULT FALSE
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_memories_container_tag
        ON memories(container_tag)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_memories_created_at
        ON memories(created_at DESC)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_memories_is_pinned
        ON memories(is_pinned)
      `);

      // User prompts table
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_prompts (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          project_path TEXT,
          content TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          captured BOOLEAN DEFAULT FALSE,
          user_learning_captured BOOLEAN DEFAULT FALSE,
          linked_memory_id TEXT
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_prompts_session
        ON user_prompts(session_id)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_prompts_captured
        ON user_prompts(captured)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_prompts_created
        ON user_prompts(created_at DESC)
      `);

      // Embedding metadata table (for migration tracking)
      await client.query(`
        CREATE TABLE IF NOT EXISTS embedding_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      // User profiles table
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_profiles (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          display_name TEXT,
          user_name TEXT,
          user_email TEXT,
          profile_data JSONB NOT NULL DEFAULT '{}',
          version INTEGER NOT NULL DEFAULT 1,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          last_analyzed_at TIMESTAMPTZ DEFAULT NOW(),
          total_prompts_analyzed INTEGER DEFAULT 0,
          is_active BOOLEAN DEFAULT TRUE
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id
        ON user_profiles(user_id)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_profiles_active
        ON user_profiles(is_active)
      `);

      // User profile changelogs table
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_profile_changelogs (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          change_type TEXT NOT NULL,
          change_summary TEXT,
          profile_data_snapshot JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_changelogs_profile
        ON user_profile_changelogs(profile_id)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_changelogs_version
        ON user_profile_changelogs(version DESC)
      `);

      // AI sessions table
      await client.query(`
        CREATE TABLE IF NOT EXISTS ai_sessions (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          session_id TEXT NOT NULL,
          conversation_id TEXT,
          metadata JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_ai_sessions_session_provider
        ON ai_sessions(session_id, provider)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_ai_sessions_expires
        ON ai_sessions(expires_at)
      `);

      // AI messages table
      await client.query(`
        CREATE TABLE IF NOT EXISTS ai_messages (
          id SERIAL PRIMARY KEY,
          ai_session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT,
          tool_calls JSONB,
          tool_call_id TEXT,
          content_blocks JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_ai_messages_session
        ON ai_messages(ai_session_id)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_ai_messages_sequence
        ON ai_messages(ai_session_id, sequence)
      `);

      const indexExists = await client.query(`
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'idx_memories_embedding'
      `);

      if (indexExists.rows.length === 0) {
        const countResult = await client.query("SELECT COUNT(*) FROM memories");
        const count = parseInt(countResult.rows[0].count, 10);

        if (count >= 1000) {
          const lists = Math.max(Math.floor(Math.sqrt(count)), 100);
          await client.query(`
            CREATE INDEX idx_memories_embedding
            ON memories USING ivfflat (embedding vector_cosine_ops)
            WITH (lists = ${lists})
          `);
        }
      }

      this.initialized = true;
      log("PostgreSQL schema initialized");
    } catch (error) {
      log("Failed to initialize PostgreSQL schema", { error: String(error) });
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.initialized = false;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const pool = await this.getPool();
      const result = await pool.query("SELECT 1");
      return result.rows.length > 0;
    } catch {
      return false;
    }
  }
}

export const connectionManager = new ConnectionManager();
