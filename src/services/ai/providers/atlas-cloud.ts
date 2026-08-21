import type { AIProviderType } from "../session/session-types.js";
import { OpenAIChatCompletionProvider } from "./openai-chat-completion.js";

export class AtlasCloudProvider extends OpenAIChatCompletionProvider {
  override getProviderName(): string {
    return "atlas-cloud";
  }

  protected override sessionProviderTag(): AIProviderType {
    return "atlas-cloud";
  }
}
