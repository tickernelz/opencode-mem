import { OpenAIChatCompletionProvider } from "./openai-chat-completion.js";
import type { ProviderConfig } from "./base-provider.js";
import type { AISessionManager } from "../session/ai-session-manager.js";
import type { AIProviderType } from "../session/session-types.js";
import { MEMORY_PROVIDER_PRESET_DEFAULTS } from "../memory-provider-presets.js";

/** TeamoRouter OpenAI-compatible endpoint used when `memoryApiUrl` is omitted. */
export const TEAMOROUTER_API_URL = MEMORY_PROVIDER_PRESET_DEFAULTS.teamorouter.apiUrl;

/**
 * Default model when `memoryModel` is omitted. TeamoRouter model IDs are listed
 * at `https://api.teamorouter.com/v1/models` and are sent unchanged; they are bare
 * ids without a vendor prefix (e.g. `deepseek-v4-flash`).
 */
export const TEAMOROUTER_DEFAULT_MODEL = MEMORY_PROVIDER_PRESET_DEFAULTS.teamorouter.model;

/**
 * TeamoRouter provider.
 *
 * [TeamoRouter](https://teamorouter.com) exposes an OpenAI-compatible Chat
 * Completions API. This provider reuses the OpenAI Chat Completions request
 * handling and only overrides the resolved endpoint, default model, and the
 * session provider tag, so TeamoRouter sessions are distinguishable in the
 * session store and diagnostics.
 *
 * Users configure it as:
 *   "memoryProvider": "teamorouter"
 *   "memoryApiKey": "env://TEAMOROUTER_API_KEY"
 *
 * API keys are created at https://teamorouter.com/dashboard?tab=api-keys; API docs are at
 * https://teamorouter.com/docs.
 *
 * `memoryApiUrl` and `memoryModel` are optional; they default to the TeamoRouter endpoint and `deepseek-v4-flash` respectively.
 *
 * When this provider is selected, auto-capture / profile prompts, model
 * responses, and relevant conversation context are transmitted to
 * `https://api.teamorouter.com`.
 */
export class TeamoRouterProvider extends OpenAIChatCompletionProvider {
  constructor(config: ProviderConfig, aiSessionManager: AISessionManager) {
    super(config, aiSessionManager);
  }

  override getProviderName(): string {
    return "teamorouter";
  }

  protected override sessionProviderTag(): AIProviderType {
    return "teamorouter";
  }

  /**
   * Resolve the OpenAI-compatible endpoint.
   *
   * Defaults to the TeamoRouter API when `memoryApiUrl` is not configured,
   * so a minimal config only needs `memoryProvider` + `memoryApiKey`.
   */
  override resolveEndpoint(): string {
    const base = (this.config.apiUrl || "").trim().replace(/\/+$/, "");
    return base || TEAMOROUTER_API_URL;
  }

  /**
   * Resolve the model ID to send to TeamoRouter.
   *
   * Defaults to `deepseek-v4-flash` when `memoryModel` is not configured.
   */
  override resolveModel(): string {
    const model = (this.config.model || "").trim();
    return model || TEAMOROUTER_DEFAULT_MODEL;
  }
}
