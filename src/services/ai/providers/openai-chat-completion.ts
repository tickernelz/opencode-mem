import type { ProviderConfig } from "./base-provider.js";
import type { AISessionManager } from "../session/ai-session-manager.js";
import type { AIProviderType } from "../session/session-types.js";
import type { ChatCompletionTool } from "../tools/tool-schema.js";
import { OpenAIChatCompletionBaseProvider } from "./openai-chat-completion-base.js";

export class OpenAIChatCompletionProvider extends OpenAIChatCompletionBaseProvider {
  constructor(config: ProviderConfig, aiSessionManager: AISessionManager) {
    super(config, aiSessionManager);
  }

  getProviderName(): string {
    return "openai-chat";
  }

  protected getSessionProviderType(): AIProviderType {
    return "openai-chat";
  }

  protected getApiErrorLogLabel(): string {
    return "OpenAI Chat Completion API error";
  }

  protected getResponseBodyErrorLogLabel(): string {
    return "API returned error in response body";
  }

  protected getInvalidResponseLogLabel(): string {
    return "Invalid API response format";
  }

  protected getToolValidationLogLabel(): string {
    return "OpenAI tool response validation failed";
  }

  protected buildRetryPrompt(_toolSchema: ChatCompletionTool): string {
    return "Please use the save_memories tool to extract and save the memories from the conversation as instructed.";
  }
}
