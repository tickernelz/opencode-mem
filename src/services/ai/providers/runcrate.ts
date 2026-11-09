import { OpenAIChatCompletionProvider } from "./openai-chat-completion.js";
import type { ProviderConfig } from "./base-provider.js";
import type { AISessionManager } from "../session/ai-session-manager.js";
import type { AIProviderType } from "../session/session-types.js";
import { MEMORY_PROVIDER_PRESET_DEFAULTS } from "../memory-provider-presets.js";

/** Runcrate OpenAI-compatible endpoint used when `memoryApiUrl` is omitted. */
export const RUNCRATE_API_URL = MEMORY_PROVIDER_PRESET_DEFAULTS.runcrate.apiUrl;

/**
 * Default model when `memoryModel` is omitted. Runcrate model IDs are
 * `vendor/model` pairs and are sent unchanged (e.g. `deepseek-ai/DeepSeek-V4.1-Flash`).
 */
export const RUNCRATE_DEFAULT_MODEL = MEMORY_PROVIDER_PRESET_DEFAULTS.runcrate.model;

/**
 * Runcrate provider.
 *
 * [Runcrate](https://www.runcrate.ai) exposes an OpenAI-compatible Chat
 * Completions API for open models. This provider reuses the OpenAI Chat
 * Completions request handling and only overrides the resolved endpoint,
 * default model, and the session provider tag, so Runcrate sessions are
 * distinguishable in the session store and diagnostics.
 *
 * Users configure it as:
 *   "memoryProvider": "runcrate"
 *   "memoryApiKey": "env://RUNCRATE_API_KEY"
 *
 * `memoryApiUrl` and `memoryModel` are optional — they default to the Runcrate endpoint and `deepseek-ai/DeepSeek-V4.1-Flash` respectively.
 *
 * When this provider is selected, auto-capture / profile prompts, model
 * responses, and relevant conversation context are transmitted to
 * `https://api.runcrate.ai`.
 */
export class RuncrateProvider extends OpenAIChatCompletionProvider {
  constructor(config: ProviderConfig, aiSessionManager: AISessionManager) {
    super(config, aiSessionManager);
  }

  override getProviderName(): string {
    return "runcrate";
  }

  protected override sessionProviderTag(): AIProviderType {
    return "runcrate";
  }

  /**
   * Resolve the OpenAI-compatible endpoint.
   *
   * Defaults to the Runcrate API when `memoryApiUrl` is not configured,
   * so a minimal config only needs `memoryProvider` + `memoryApiKey`.
   */
  override resolveEndpoint(): string {
    const base = (this.config.apiUrl || "").trim().replace(/\/+$/, "");
    return base || RUNCRATE_API_URL;
  }

  /**
   * Resolve the model ID to send to Runcrate.
   *
   * Defaults to `deepseek-ai/DeepSeek-V4.1-Flash` when `memoryModel` is not configured.
   */
  override resolveModel(): string {
    const model = (this.config.model || "").trim();
    return model || RUNCRATE_DEFAULT_MODEL;
  }
}
