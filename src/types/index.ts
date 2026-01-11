export type MemoryScope = "user" | "project";

export type MemoryType = string;

export type ConversationRole = "user" | "assistant" | "system" | "tool";

export type ConversationContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; imageUrl: { url: string } };

export interface ConversationToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ConversationMessage {
  role: ConversationRole;
  content: string | ConversationContentPart[];
  name?: string;
  tool_calls?: ConversationToolCall[];
  tool_call_id?: string;
}

export interface ConversationIngestResponse {
  id: string;
  conversationId: string;
  status: string;
}

export interface MemoryMetadata {
  type?: MemoryType;
  source?: "manual" | "auto-capture" | "import" | "api";
  tool?: string;
  sessionID?: string;
  reasoning?: string;
  captureTimestamp?: number;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
  [key: string]: unknown;
}

export type AIProviderType = "openai-chat" | "openai-responses" | "anthropic";
