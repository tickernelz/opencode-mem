import { OpenAIChatCompletionProvider } from "./openai-chat-completion.js";
import type { ProviderConfig } from "./base-provider.js";
import type { AISessionManager } from "../session/ai-session-manager.js";
import type { AIProviderType } from "../session/session-types.js";
import { MEMORY_PROVIDER_PRESET_DEFAULTS } from "../memory-provider-presets.js";

/** API Route OpenAI-compatible endpoint used when `memoryApiUrl` is omitted. */
export const API_ROUTE_API_URL = MEMORY_PROVIDER_PRESET_DEFAULTS["api-route"].apiUrl;

/**
 * Default model when `memoryModel` is omitted. API Route model IDs are
 * sent unchanged (e.g. `gpt-6.1-sol`).
 */
export const API_ROUTE_DEFAULT_MODEL = MEMORY_PROVIDER_PRESET_DEFAULTS["api-route"].model;

/**
 * API Route provider.
 *
 * [API Route](https://www.api-route.com/en/docs/quickstart) exposes an OpenAI-compatible
 * Chat Completions API. This provider reuses the OpenAI Chat Completions request
 * handling and only overrides the resolved endpoint, default model, and the
 * session provider tag, so API Route sessions are distinguishable in the
 * session store and diagnostics.
 *
 * Users configure it as:
 *   "memoryProvider": "api-route"
 *   "memoryApiKey": "env://API_ROUTE_API_KEY"
 *
 * `memoryApiUrl` and `memoryModel` are optional — they default to the API Route endpoint and `gpt-6.1-sol` respectively.
 *
 * When this provider is selected, auto-capture / profile prompts, model
 * responses, and relevant conversation context are transmitted to
 * `https://global.api-route.com`.
 */
export class APIRouteProvider extends OpenAIChatCompletionProvider {
  constructor(config: ProviderConfig, aiSessionManager: AISessionManager) {
    super(config, aiSessionManager);
  }

  override getProviderName(): string {
    return "api-route";
  }

  protected override sessionProviderTag(): AIProviderType {
    return "api-route";
  }

  /**
   * Resolve the OpenAI-compatible endpoint.
   *
   * Defaults to the API Route API when `memoryApiUrl` is not configured,
   * so a minimal config only needs `memoryProvider` + `memoryApiKey`.
   */
  override resolveEndpoint(): string {
    const base = (this.config.apiUrl || "").trim().replace(/\/+$/, "");
    return base || API_ROUTE_API_URL;
  }

  /**
   * Resolve the model ID to send to API Route.
   *
   * Defaults to `gpt-6.1-sol` when `memoryModel` is not configured.
   */
  override resolveModel(): string {
    const model = (this.config.model || "").trim();
    return model || API_ROUTE_DEFAULT_MODEL;
  }
}
