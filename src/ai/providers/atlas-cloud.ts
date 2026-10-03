import { OpenAIChatCompletionProvider } from "./openai-chat-completion.js";
import type { ProviderConfig } from "./base-provider.js";
import type { AISessionManager } from "../session/ai-session-manager.js";
import type { AIProviderType } from "../session/session-types.js";

/** Atlas Cloud OpenAI-compatible endpoint used when `memoryApiUrl` is omitted. */
export const ATLAS_CLOUD_API_URL = "https://api.atlascloud.ai/v1";

/**
 * Default model when `memoryModel` is omitted. Atlas Cloud model IDs are
 * typically namespaced (e.g. `deepseek-ai/deepseek-v4-pro`).
 */
export const ATLAS_CLOUD_DEFAULT_MODEL = "deepseek-ai/deepseek-v4-pro";

/**
 * Atlas Cloud provider.
 *
 * [Atlas Cloud](https://www.atlascloud.ai) exposes an OpenAI-compatible Chat
 * Completions API. This provider reuses the OpenAI Chat Completions request
 * handling and only overrides the resolved endpoint, default model, and the
 * session provider tag, so Atlas sessions are distinguishable in the session
 * store and diagnostics.
 *
 * Users configure it as:
 *   "memoryProvider": "atlas-cloud"
 *   "memoryApiKey": "env://ATLASCLOUD_API_KEY"
 *
 * `memoryApiUrl` and `memoryModel` are optional — they default to the Atlas
 * endpoint and `deepseek-ai/deepseek-v4-pro` respectively.
 *
 * When this provider is selected, auto-capture / profile prompts, model
 * responses, and relevant conversation context are transmitted to
 * `https://api.atlascloud.ai`.
 */
export class AtlasCloudProvider extends OpenAIChatCompletionProvider {
  constructor(config: ProviderConfig, aiSessionManager: AISessionManager) {
    super(config, aiSessionManager);
  }

  override getProviderName(): string {
    return "atlas-cloud";
  }

  protected override sessionProviderTag(): AIProviderType {
    return "atlas-cloud";
  }

  /**
   * Resolve the OpenAI-compatible endpoint.
   *
   * Defaults to the Atlas Cloud API when `memoryApiUrl` is not configured,
   * so a minimal config only needs `memoryProvider` + `memoryApiKey`.
   */
  override resolveEndpoint(): string {
    const base = (this.config.apiUrl || "").trim().replace(/\/+$/, "");
    return base || ATLAS_CLOUD_API_URL;
  }

  /**
   * Resolve the model ID to send to Atlas Cloud.
   *
   * Defaults to `deepseek-ai/deepseek-v4-pro` when `memoryModel` is not
   * configured.
   */
  override resolveModel(): string {
    const model = (this.config.model || "").trim();
    return model || ATLAS_CLOUD_DEFAULT_MODEL;
  }
}
