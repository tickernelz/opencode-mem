import { OpenAIChatCompletionProvider } from "./openai-chat-completion.js";
import type { ProviderConfig } from "./base-provider.js";
import type { AISessionManager } from "../session/ai-session-manager.js";
import type { AIProviderType } from "../session/session-types.js";
import { MEMORY_PROVIDER_PRESET_DEFAULTS } from "../memory-provider-presets.js";

/** onomeo OpenAI-compatible endpoint used when `memoryApiUrl` is omitted. */
export const ONOMEO_API_URL = MEMORY_PROVIDER_PRESET_DEFAULTS.onomeo.apiUrl;

/**
 * Default model when `memoryModel` is omitted. onomeo model IDs are listed
 * at `https://onomeo.com/v1/models` and are sent unchanged; they are bare
 * ids without a vendor prefix (e.g. `deepseek-v4.1-flash`).
 */
export const ONOMEO_DEFAULT_MODEL = MEMORY_PROVIDER_PRESET_DEFAULTS.onomeo.model;

/**
 * onomeo provider.
 *
 * [onomeo](https://onomeo.com) exposes an OpenAI-compatible Chat
 * Completions API. This provider reuses the OpenAI Chat Completions request
 * handling and only overrides the resolved endpoint, default model, and the
 * session provider tag, so onomeo sessions are distinguishable in the
 * session store and diagnostics.
 *
 * Users configure it as:
 *   "memoryProvider": "onomeo"
 *   "memoryApiKey": "env://ONOMEO_API_KEY"
 *
 * API keys are created at https://onomeo.com/dashboard; API docs are at
 * https://onomeo.com/integrations.
 *
 * `memoryApiUrl` and `memoryModel` are optional; they default to the onomeo endpoint and `deepseek-v4.1-flash` respectively.
 *
 * When this provider is selected, auto-capture / profile prompts, model
 * responses, and relevant conversation context are transmitted to
 * `https://onomeo.com`.
 */
export class OnomeoProvider extends OpenAIChatCompletionProvider {
  constructor(config: ProviderConfig, aiSessionManager: AISessionManager) {
    super(config, aiSessionManager);
  }

  override getProviderName(): string {
    return "onomeo";
  }

  protected override sessionProviderTag(): AIProviderType {
    return "onomeo";
  }

  /**
   * Resolve the OpenAI-compatible endpoint.
   *
   * Defaults to the onomeo API when `memoryApiUrl` is not configured,
   * so a minimal config only needs `memoryProvider` + `memoryApiKey`.
   */
  override resolveEndpoint(): string {
    const base = (this.config.apiUrl || "").trim().replace(/\/+$/, "");
    return base || ONOMEO_API_URL;
  }

  /**
   * Resolve the model ID to send to onomeo.
   *
   * Defaults to `deepseek-v4.1-flash` when `memoryModel` is not configured.
   */
  override resolveModel(): string {
    const model = (this.config.model || "").trim();
    return model || ONOMEO_DEFAULT_MODEL;
  }
}
