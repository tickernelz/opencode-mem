import { OpenAIChatCompletionProvider } from "./openai-chat-completion.js";
import type { ProviderConfig } from "./base-provider.js";
import type { AISessionManager } from "../session/ai-session-manager.js";
import type { AIProviderType } from "../session/session-types.js";
import { MEMORY_PROVIDER_PRESET_DEFAULTS } from "../memory-provider-presets.js";

/** MartLLM OpenAI-compatible endpoint used when `memoryApiUrl` is omitted. */
export const UBERLLM_API_URL = MEMORY_PROVIDER_PRESET_DEFAULTS.uberllm.apiUrl;

/**
 * Default model when `memoryModel` is omitted. MartLLM model IDs are listed
 * at `https://api.martllm.com/v1/models` and are sent unchanged; they keep the
 * vendor prefix (e.g. `deepseek/deepseek-v4-flash`).
 */
export const UBERLLM_DEFAULT_MODEL = MEMORY_PROVIDER_PRESET_DEFAULTS.uberllm.model;

/**
 * MartLLM provider.
 *
 * [MartLLM](https://martllm.com) exposes an OpenAI-compatible Chat
 * Completions API. This provider reuses the OpenAI Chat Completions request
 * handling and only overrides the resolved endpoint, default model, and the
 * session provider tag, so MartLLM sessions are distinguishable in the
 * session store and diagnostics.
 *
 * Users configure it as:
 *   "memoryProvider": "uberllm"
 *   "memoryApiKey": "env://UBERLLM_API_KEY"
 *
 * API keys are created at https://martllm.com/signup; API docs are at
 * https://martllm.com/docs/quickstart.
 *
 * `memoryApiUrl` and `memoryModel` are optional — they default to the MartLLM endpoint and `deepseek/deepseek-v4-flash` respectively.
 *
 * When this provider is selected, auto-capture / profile prompts, model
 * responses, and relevant conversation context are transmitted to
 * `https://api.martllm.com`.
 */
export class UberLLMProvider extends OpenAIChatCompletionProvider {
  constructor(config: ProviderConfig, aiSessionManager: AISessionManager) {
    super(config, aiSessionManager);
  }

  override getProviderName(): string {
    return "uberllm";
  }

  protected override sessionProviderTag(): AIProviderType {
    return "uberllm";
  }

  /**
   * Resolve the OpenAI-compatible endpoint.
   *
   * Defaults to the MartLLM API when `memoryApiUrl` is not configured,
   * so a minimal config only needs `memoryProvider` + `memoryApiKey`.
   */
  override resolveEndpoint(): string {
    const base = (this.config.apiUrl || "").trim().replace(/\/+$/, "");
    return base || UBERLLM_API_URL;
  }

  /**
   * Resolve the model ID to send to MartLLM.
   *
   * Defaults to `deepseek/deepseek-v4-flash` when `memoryModel` is not configured.
   */
  override resolveModel(): string {
    const model = (this.config.model || "").trim();
    return model || UBERLLM_DEFAULT_MODEL;
  }
}
