import { BaseAIProvider, type ProviderConfig } from "./providers/base-provider.js";
import { OpenAIChatCompletionProvider } from "./providers/openai-chat-completion.js";
import { OpenAIResponsesProvider } from "./providers/openai-responses.js";
import { AnthropicMessagesProvider } from "./providers/anthropic-messages.js";
import { GitHubCopilotProvider } from "./providers/github-copilot.js";
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

      case "github-copilot":
        return new GitHubCopilotProvider(config, aiSessionManager);

      default:
        throw new Error(`Unknown provider type: ${providerType}`);
    }
  }

  static getSupportedProviders(): AIProviderType[] {
    return ["openai-chat", "openai-responses", "anthropic", "github-copilot"];
  }

  static cleanupExpiredSessions(): number {
    return aiSessionManager.cleanupExpiredSessions();
  }
}
