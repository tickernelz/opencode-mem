import type { ProviderConfig } from "./base-provider.js";
import type { AISessionManager } from "../session/ai-session-manager.js";
import type { AIProviderType } from "../session/session-types.js";
import type { ChatCompletionTool } from "../tools/tool-schema.js";
import { OpenAIChatCompletionBaseProvider } from "./openai-chat-completion-base.js";

export class DeepSeekProvider extends OpenAIChatCompletionBaseProvider {
  constructor(config: ProviderConfig, aiSessionManager: AISessionManager) {
    super(config, aiSessionManager);
  }

  getProviderName(): string {
    return "deepseek";
  }

  protected getSessionProviderType(): AIProviderType {
    return "deepseek";
  }

  protected getApiErrorLogLabel(): string {
    return "DeepSeek API error";
  }

  protected getResponseBodyErrorLogLabel(): string {
    return "DeepSeek API returned error in response body";
  }

  protected getInvalidResponseLogLabel(): string {
    return "Invalid DeepSeek API response format";
  }

  protected getToolValidationLogLabel(): string {
    return "DeepSeek tool response validation failed";
  }

  protected buildRetryPrompt(toolSchema: ChatCompletionTool): string {
    return `Please use the ${toolSchema.function.name} tool to extract and save the memories from the conversation as instructed.`;
  }
}
