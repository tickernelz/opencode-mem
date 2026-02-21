export type KnowledgeType =
  | "tech-stack"
  | "architecture"
  | "coding-standard"
  | "lesson"
  | "business-logic";

export type KnowledgeSourceType = "code" | "config" | "conversation" | "commit";

export interface KnowledgeItem {
  id: string;
  type: KnowledgeType;
  title: string;
  content: string;
  sourceKey: string;
  sourceFile?: string;
  sourceType: KnowledgeSourceType;
  confidence: number;
  version: number;
  stale: boolean;
  tags: string[];
  containerTag: string;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeExtractResult {
  items: Omit<
    KnowledgeItem,
    "id" | "version" | "stale" | "containerTag" | "createdAt" | "updatedAt"
  >[];
  errors: string[];
}

export interface SyncResult {
  added: number;
  updated: number;
  stale: number;
  errors: string[];
}

export interface KnowledgeSearchResult {
  item: KnowledgeItem;
  similarity: number;
}
