export type AIProviderType = "openai-chat" | "openai-responses" | "anthropic" | "google-gemini";

export interface AIMessage {
  id?: number;
  aiSessionId: string;
  sequence: number;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  toolCallId?: string;
  contentBlocks?: Array<{
    type: string;
    [key: string]: any;
  }>;
  createdAt: number;
}

export interface AISession {
  id: string;
  provider: AIProviderType;
  sessionId: string;
  conversationId?: string;
  metadata?: Record<string, any>;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface SessionCreateParams {
  provider: AIProviderType;
  sessionId: string;
  conversationId?: string;
  metadata?: Record<string, any>;
}

export interface SessionUpdateParams {
  conversationId?: string;
  metadata?: Record<string, any>;
}
