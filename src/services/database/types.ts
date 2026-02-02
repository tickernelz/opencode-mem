/**
 * Common database types for SQLite and PostgreSQL adapters
 */

export type DatabaseType = "sqlite" | "postgresql";

export interface MemoryRecord {
  id: string;
  content: string;
  embedding: number[];
  tagsEmbedding?: number[];
  containerTag: string;
  tags?: string;
  type?: string;
  createdAt: number;
  updatedAt: number;
  metadata?: string;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
  isPinned?: boolean;
}

export interface SearchResult {
  id: string;
  memory: string;
  similarity: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  containerTag?: string;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
  isPinned?: boolean;
}

export interface MemoryRow {
  id: string;
  content: string;
  container_tag: string;
  tags: string | null;
  type: string | null;
  created_at: number | Date;
  updated_at: number | Date;
  metadata: string | Record<string, unknown> | null;
  display_name: string | null;
  user_name: string | null;
  user_email: string | null;
  project_path: string | null;
  project_name: string | null;
  git_repo_url: string | null;
  is_pinned: boolean | number;
}

export interface DistinctTagRow {
  container_tag: string;
  display_name: string | null;
  user_name: string | null;
  user_email: string | null;
  project_path: string | null;
  project_name: string | null;
  git_repo_url: string | null;
}

export interface DatabaseConfig {
  databaseType: DatabaseType;
  // SQLite specific
  storagePath?: string;
  customSqlitePath?: string;
  maxVectorsPerShard?: number;
  embeddingDimensions: number;
  embeddingModel: string;
  // PostgreSQL specific
  databaseUrl?: string;
}
