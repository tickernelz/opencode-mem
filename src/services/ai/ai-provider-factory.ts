import { BaseAIProvider, type ProviderConfig } from "./providers/base-provider.js";
import { OpenAIChatCompletionProvider } from "./providers/openai-chat-completion.js";
import { OpenAIResponsesProvider } from "./providers/openai-responses.js";
import { AnthropicMessagesProvider } from "./providers/anthropic-messages.js";
import { MiniMaxProvider } from "./providers/minimax.js";
import { GoogleGeminiProvider } from "./providers/google-gemini.js";
import { OrcaRouterProvider } from "./providers/orcarouter.js";
import { aiSessionManager } from "./session/ai-session-manager.js";
import type { AIProviderType } from "./session/session-types.js";

export class AIProviderFactory {
  static createProvider(providerType: AIProviderType, config: ProviderConfig): BaseAIProvider {
    switch (providerType) {
      case "openai-chat":
        return new OpenAIChatCompletionProvider(config, aiSessionManager);

      case "openai-responses":
        return new OpenAIResponsesProvider(config, aiSessionManager);

      case "anthropic":
        return new AnthropicMessagesProvider(config, aiSessionManager);

      case "minimax":
        return new MiniMaxProvider(config, aiSessionManager);

      case "google-gemini":
        return new GoogleGeminiProvider(config, aiSessionManager);

      case "orcarouter":
        return new OrcaRouterProvider(config, aiSessionManager);

      default:
        throw new Error(`Unknown provider type: ${providerType}`);
    }
  }

  static getSupportedProviders(): AIProviderType[] {
    return [
      "openai-chat",
      "openai-responses",
      "anthropic",
      "minimax",
      "google-gemini",
      "orcarouter",
    ];
  }

  static async cleanupExpiredSessions(): Promise<number> {
    return aiSessionManager.cleanupExpiredSessions();
  }
}
