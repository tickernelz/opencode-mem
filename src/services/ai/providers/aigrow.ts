import { OpenAIChatCompletionProvider } from "./openai-chat-completion.js";
import type { ProviderConfig } from "./base-provider.js";
import type { AISessionManager } from "../session/ai-session-manager.js";
import type { AIProviderType } from "../session/session-types.js";
import { MEMORY_PROVIDER_PRESET_DEFAULTS } from "../memory-provider-presets.js";

/** AIGROW OpenAI-compatible endpoint used when `memoryApiUrl` is omitted. */
export const AIGROW_API_URL = MEMORY_PROVIDER_PRESET_DEFAULTS.aigrow.apiUrl;

/**
 * Default model when `memoryModel` is omitted. AIGROW model IDs are listed
 * at `https://aigrow.gg/v1/models` and are sent unchanged; they are bare
 * ids without a vendor prefix (e.g. `claude-haiku-5.5`).
 */
export const AIGROW_DEFAULT_MODEL = MEMORY_PROVIDER_PRESET_DEFAULTS.aigrow.model;

/**
 * AIGROW provider.
 *
 * [AIGROW](https://aigrow.gg/ai-api) exposes an OpenAI-compatible Chat
 * Completions API. This provider reuses the OpenAI Chat Completions request
 * handling and only overrides the resolved endpoint, default model, and the
 * session provider tag, so AIGROW sessions are distinguishable in the
 * session store and diagnostics.
 *
 * Users configure it as:
 *   "memoryProvider": "aigrow"
 *   "memoryApiKey": "env://AIGROW_API_KEY"
 *
 * API keys are created at https://aigrow.gg/dashboard/api; API docs are at
 * https://aigrow.gg/ai-api/guide.
 *
 * `memoryApiUrl` and `memoryModel` are optional; they default to the AIGROW endpoint and `claude-haiku-5.5` respectively.
 *
 * When this provider is selected, auto-capture / profile prompts, model
 * responses, and relevant conversation context are transmitted to
 * `https://aigrow.gg`.
 */
export class AigrowProvider extends OpenAIChatCompletionProvider {
  constructor(config: ProviderConfig, aiSessionManager: AISessionManager) {
    super(config, aiSessionManager);
  }

  override getProviderName(): string {
    return "aigrow";
  }

  protected override sessionProviderTag(): AIProviderType {
    return "aigrow";
  }

  /**
   * Resolve the OpenAI-compatible endpoint.
   *
   * Defaults to the AIGROW API when `memoryApiUrl` is not configured,
   * so a minimal config only needs `memoryProvider` + `memoryApiKey`.
   */
  override resolveEndpoint(): string {
    const base = (this.config.apiUrl || "").trim().replace(/\/+$/, "");
    return base || AIGROW_API_URL;
  }

  /**
   * Resolve the model ID to send to AIGROW.
   *
   * Defaults to `claude-haiku-5.5` when `memoryModel` is not configured.
   */
  override resolveModel(): string {
    const model = (this.config.model || "").trim();
    return model || AIGROW_DEFAULT_MODEL;
  }
}
