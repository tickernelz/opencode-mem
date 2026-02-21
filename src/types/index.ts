export type MemoryType = string;

export interface MemoryMetadata {
  type?: MemoryType;
  source?: "manual" | "auto-capture" | "import" | "api";
  tool?: string;
  sessionID?: string;
  reasoning?: string;
  captureTimestamp?: number;
  promptId?: string;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
  [key: string]: unknown;
}

export type AIProviderType = "openai-chat" | "openai-responses" | "anthropic";

export * from "./team-knowledge.js";
