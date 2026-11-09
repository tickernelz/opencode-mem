import { OpenAIChatCompletionProvider } from "./openai-chat-completion.js";
import type { ProviderConfig } from "./base-provider.js";
import type { AISessionManager } from "../session/ai-session-manager.js";
import type { AIProviderType } from "../session/session-types.js";
import { MEMORY_PROVIDER_PRESET_DEFAULTS } from "../memory-provider-presets.js";

/** Standard Compute OpenAI-compatible endpoint used when `memoryApiUrl` is omitted. */
export const STANDARDCOMPUTE_API_URL = MEMORY_PROVIDER_PRESET_DEFAULTS.standardcompute.apiUrl;

/**
 * Default model when `memoryModel` is omitted. Standard Compute model IDs are listed
 * at `https://api.stdcmpt.com/v1/models` and are sent unchanged. The routed
 * `StandardCompute` id picks the cheapest capable model for each request;
 * `vendor/model` ids pin one model.
 */
export const STANDARDCOMPUTE_DEFAULT_MODEL = MEMORY_PROVIDER_PRESET_DEFAULTS.standardcompute.model;

/**
 * Standard Compute provider.
 *
 * [Standard Compute](https://standardcompute.com) exposes an OpenAI-compatible Chat
 * Completions API. This provider reuses the OpenAI Chat Completions request
 * handling and only overrides the resolved endpoint, default model, and the
 * session provider tag, so Standard Compute sessions are distinguishable in the
 * session store and diagnostics.
 *
 * Users configure it as:
 *   "memoryProvider": "standardcompute"
 *   "memoryApiKey": "env://STANDARDCOMPUTE_API_KEY"
 *
 * API keys are created at https://standardcompute.com/dashboard; API docs are at
 * https://docs.standardcompute.com.
 *
 * `memoryApiUrl` and `memoryModel` are optional — they default to the Standard Compute endpoint and `StandardCompute` respectively.
 *
 * When this provider is selected, auto-capture / profile prompts, model
 * responses, and relevant conversation context are transmitted to
 * `https://api.stdcmpt.com`.
 */
export class StandardComputeProvider extends OpenAIChatCompletionProvider {
  constructor(config: ProviderConfig, aiSessionManager: AISessionManager) {
    super(config, aiSessionManager);
  }

  override getProviderName(): string {
    return "standardcompute";
  }

  protected override sessionProviderTag(): AIProviderType {
    return "standardcompute";
  }

  /**
   * Resolve the OpenAI-compatible endpoint.
   *
   * Defaults to the Standard Compute API when `memoryApiUrl` is not configured,
   * so a minimal config only needs `memoryProvider` + `memoryApiKey`.
   */
  override resolveEndpoint(): string {
    const base = (this.config.apiUrl || "").trim().replace(/\/+$/, "");
    return base || STANDARDCOMPUTE_API_URL;
  }

  /**
   * Resolve the model ID to send to Standard Compute.
   *
   * Defaults to `StandardCompute` when `memoryModel` is not configured.
   */
  override resolveModel(): string {
    const model = (this.config.model || "").trim();
    return model || STANDARDCOMPUTE_DEFAULT_MODEL;
  }
}
