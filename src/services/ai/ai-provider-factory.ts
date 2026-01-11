import { BaseAIProvider, type ProviderConfig } from "./providers/base-provider.js";
import { OpenAIChatCompletionProvider } from "./providers/openai-chat-completion.js";
import { OpenAIResponsesProvider } from "./providers/openai-responses.js";
import { AnthropicMessagesProvider } from "./providers/anthropic-messages.js";
import { SessionStore } from "./session/session-store.js";
import type { AIProviderType } from "./session/session-types.js";

export class AIProviderFactory {
  private static sessionStore: SessionStore | null = null;

  static initializeSessionStore(storagePath: string, retentionDays: number): void {
    if (!this.sessionStore) {
      this.sessionStore = new SessionStore(storagePath, retentionDays);
    }
  }

  static createProvider(providerType: AIProviderType, config: ProviderConfig): BaseAIProvider {
    switch (providerType) {
      case "openai-chat":
        return new OpenAIChatCompletionProvider(config);

      case "openai-responses":
        if (!this.sessionStore) {
          throw new Error("Session store not initialized for openai-responses provider");
        }
        return new OpenAIResponsesProvider(config, this.sessionStore);

      case "anthropic":
        if (!this.sessionStore) {
          throw new Error("Session store not initialized for anthropic provider");
        }
        return new AnthropicMessagesProvider(config, this.sessionStore);

      default:
        throw new Error(`Unknown provider type: ${providerType}`);
    }
  }

  static getSupportedProviders(): AIProviderType[] {
    return ["openai-chat", "openai-responses", "anthropic"];
  }

  static getSessionStore(): SessionStore | null {
    return this.sessionStore;
  }

  static cleanupExpiredSessions(): number {
    if (!this.sessionStore) {
      return 0;
    }
    return this.sessionStore.cleanupExpiredSessions();
  }

  static closeSessionStore(): void {
    if (this.sessionStore) {
      this.sessionStore.close();
      this.sessionStore = null;
    }
  }
}
