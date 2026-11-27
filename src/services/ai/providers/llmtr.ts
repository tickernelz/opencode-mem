import { OpenAIChatCompletionProvider } from "./openai-chat-completion.js";
import type { ProviderConfig } from "./base-provider.js";
import type { AISessionManager } from "../session/ai-session-manager.js";
import type { AIProviderType } from "../session/session-types.js";
import { MEMORY_PROVIDER_PRESET_DEFAULTS } from "../memory-provider-presets.js";

/** LLMTR OpenAI-compatible endpoint used when `memoryApiUrl` is omitted. */
export const LLMTR_API_URL = MEMORY_PROVIDER_PRESET_DEFAULTS.llmtr.apiUrl;

/**
 * Default model when `memoryModel` is omitted. LLMTR model IDs are listed
 * at `https://llmtr.com/v1/models` and are sent unchanged; they use a
 * vendor/model form (e.g. `qwen/qwen3.8-flash`).
 */
export const LLMTR_DEFAULT_MODEL = MEMORY_PROVIDER_PRESET_DEFAULTS.llmtr.model;

/**
 * LLMTR provider.
 *
 * [LLMTR](https://llmtr.com) exposes an OpenAI-compatible Chat Completions
 * API. This provider reuses the OpenAI Chat Completions request handling and
 * only overrides the resolved endpoint, default model, and the session
 * provider tag, so LLMTR sessions are distinguishable in the session store
 * and diagnostics.
 *
 * Users configure it as:
 *   "memoryProvider": "llmtr"
 *   "memoryApiKey": "env://LLMTR_API_KEY"
 *
 * API keys are created at https://llmtr.com/dashboard/keys; the model list
 * is available at `GET https://llmtr.com/v1/models`.
 *
 * `memoryApiUrl` and `memoryModel` are optional; they default to the LLMTR
 * endpoint and `qwen/qwen3.8-flash` respectively.
 *
 * When this provider is selected, auto-capture / profile prompts, model
 * responses, and relevant conversation context are transmitted to
 * `https://llmtr.com`.
 */
export class LLMTRProvider extends OpenAIChatCompletionProvider {
  constructor(config: ProviderConfig, aiSessionManager: AISessionManager) {
    super(config, aiSessionManager);
  }

  override getProviderName(): string {
    return "llmtr";
  }

  protected override sessionProviderTag(): AIProviderType {
    return "llmtr";
  }

  /**
   * Resolve the OpenAI-compatible endpoint.
   *
   * Defaults to the LLMTR API when `memoryApiUrl` is not configured,
   * so a minimal config only needs `memoryProvider` + `memoryApiKey`.
   */
  override resolveEndpoint(): string {
    const base = (this.config.apiUrl || "").trim().replace(/\/+$/, "");
    return base || LLMTR_API_URL;
  }

  /**
   * Resolve the model ID to send to LLMTR.
   *
   * Defaults to `qwen/qwen3.8-flash` when `memoryModel` is not configured.
   */
  override resolveModel(): string {
    const model = (this.config.model || "").trim();
    return model || LLMTR_DEFAULT_MODEL;
  }
}
