import { BaseAIProvider, type ProviderConfig } from "./providers/base-provider.js";
import { OpenAIChatCompletionProvider } from "./providers/openai-chat-completion.js";
import { OpenAIResponsesProvider } from "./providers/openai-responses.js";
import { AnthropicMessagesProvider } from "./providers/anthropic-messages.js";
import { MiniMaxProvider } from "./providers/minimax.js";
import { GoogleGeminiProvider } from "./providers/google-gemini.js";
import { AtlasCloudProvider } from "./providers/atlas-cloud.js";
import { APIRouteProvider } from "./providers/api-route.js";
import { CheaperInferenceProvider } from "./providers/cheaper-inference.js";
import { OrcaRouterProvider } from "./providers/orcarouter.js";
import { RuncrateProvider } from "./providers/runcrate.js";
import { CloudGPUProvider } from "./providers/cloudgpu.js";
import { StandardComputeProvider } from "./providers/standardcompute.js";
import { UberLLMProvider } from "./providers/uberllm.js";
import { aiSessionManager } from "./session/ai-session-manager.js";
import type { AIProviderType } from "./session/session-types.js";

export class AIProviderFactory {
  static createProvider(providerType: AIProviderType, config: ProviderConfig): BaseAIProvider {
    switch (providerType) {
      case "atlas-cloud":
        return new AtlasCloudProvider(config, aiSessionManager);

      case "api-route":
        return new APIRouteProvider(config, aiSessionManager);

      case "runcrate":
        return new RuncrateProvider(config, aiSessionManager);

      case "cloudgpu":
        return new CloudGPUProvider(config, aiSessionManager);

      case "standardcompute":
        return new StandardComputeProvider(config, aiSessionManager);

      case "uberllm":
        return new UberLLMProvider(config, aiSessionManager);

      case "cheaper-inference":
        return new CheaperInferenceProvider(config, aiSessionManager);

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
      "atlas-cloud",
      "cheaper-inference",
      "api-route",
      "openai-chat",
      "openai-responses",
      "anthropic",
      "minimax",
      "google-gemini",
      "orcarouter",
      "runcrate",
      "cloudgpu",
      "standardcompute",
      "uberllm",
    ];
  }

  static async cleanupExpiredSessions(): Promise<number> {
    return aiSessionManager.cleanupExpiredSessions();
  }
}
