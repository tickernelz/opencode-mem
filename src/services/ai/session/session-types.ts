export type AIProviderType = 'openai-chat' | 'openai-responses' | 'anthropic';

export interface AISession {
  id: string;
  provider: AIProviderType;
  sessionId: string;
  conversationId?: string;
  lastResponseId?: string;
  messageHistory?: any[];
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
  lastResponseId?: string;
  messageHistory?: any[];
  metadata?: Record<string, any>;
}
