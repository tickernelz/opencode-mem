import { OpenAIChatCompletionProvider } from "./openai-chat-completion.js";
import type { ProviderConfig } from "./base-provider.js";
import type { AISessionManager } from "../session/ai-session-manager.js";
import type { AIProviderType } from "../session/session-types.js";
import { MEMORY_PROVIDER_PRESET_DEFAULTS } from "../memory-provider-presets.js";

/** Cheaper Inference OpenAI-compatible endpoint used when `memoryApiUrl` is omitted. */
export const CHEAPER_INFERENCE_API_URL =
  MEMORY_PROVIDER_PRESET_DEFAULTS["cheaper-inference"].apiUrl;

/**
 * Default model when `memoryModel` is omitted. Cheaper Inference model IDs are
 * bare (e.g. `gpt-5.4-mini`, `claude-sonnet-5`).
 */
export const CHEAPER_INFERENCE_DEFAULT_MODEL =
  MEMORY_PROVIDER_PRESET_DEFAULTS["cheaper-inference"].model;

/**
 * Cheaper Inference provider.
 *
 * [Cheaper Inference](https://cheaperinference.com) exposes an OpenAI-compatible
 * Chat Completions API. This provider reuses the OpenAI Chat Completions request
 * handling and only overrides the resolved endpoint, default model, and the
 * session provider tag, so Cheaper Inference sessions are distinguishable in the
 * session store and diagnostics.
 *
 * Users configure it as:
 *   "memoryProvider": "cheaper-inference"
 *   "memoryApiKey": "env://CHEAPER_INFERENCE_API_KEY"
 *
 * `memoryApiUrl` and `memoryModel` are optional — they default to the Cheaper
 * Inference endpoint and `gpt-5.4-mini` respectively.
 *
 * When this provider is selected, auto-capture / profile prompts, model
 * responses, and relevant conversation context are transmitted to
 * `https://api.cheaperinference.com`.
 */
export class CheaperInferenceProvider extends OpenAIChatCompletionProvider {
  constructor(config: ProviderConfig, aiSessionManager: AISessionManager) {
    super(config, aiSessionManager);
  }

  override getProviderName(): string {
    return "cheaper-inference";
  }

  protected override sessionProviderTag(): AIProviderType {
    return "cheaper-inference";
  }

  /**
   * Resolve the OpenAI-compatible endpoint.
   *
   * Defaults to the Cheaper Inference API when `memoryApiUrl` is not configured,
   * so a minimal config only needs `memoryProvider` + `memoryApiKey`.
   */
  override resolveEndpoint(): string {
    const base = (this.config.apiUrl || "").trim().replace(/\/+$/, "");
    return base || CHEAPER_INFERENCE_API_URL;
  }

  /**
   * Resolve the model ID to send to Cheaper Inference.
   *
   * Defaults to `gpt-5.4-mini` when `memoryModel` is not configured.
   */
  override resolveModel(): string {
    const model = (this.config.model || "").trim();
    return model || CHEAPER_INFERENCE_DEFAULT_MODEL;
  }
}
