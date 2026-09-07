import { OpenAIChatCompletionProvider } from "./openai-chat-completion.js";
import type { ProviderConfig } from "./base-provider.js";
import type { AISessionManager } from "../session/ai-session-manager.js";
import type { AIProviderType } from "../session/session-types.js";

/** OrcaRouter OpenAI-compatible endpoint used when `memoryApiUrl` is omitted. */
export const ORCAROUTER_API_URL = "https://api.orcarouter.ai/v1";

/**
 * Default model when `memoryModel` is omitted. `orcarouter/auto` is the
 * gateway's routing alias — it picks a capable upstream model per request
 * (including structured / tool-call output, which auto-capture relies on).
 */
export const ORCAROUTER_DEFAULT_MODEL = "orcarouter/auto";

/**
 * OrcaRouter provider.
 *
 * [OrcaRouter](https://www.orcarouter.ai) is an OpenAI-compatible model
 * gateway. It rejects bare model names, so the gateway requires namespaced
 * model IDs such as `orcarouter/auto`, `deepseek/deepseek-v4-flash`, or
 * `openai/gpt-5.5`. This provider reuses the OpenAI Chat Completions request
 * handling and only overrides the resolved endpoint, the model resolution
 * (validating the namespace), and the session provider tag, so OrcaRouter is
 * distinguishable in the session store and diagnostics.
 *
 * Users configure it as:
 *   "memoryProvider": "orcarouter"
 *   "memoryApiKey": "<OrcaRouter API key>"
 *
 * `memoryApiUrl` and `memoryModel` are optional — they default to the gateway
 * endpoint and `orcarouter/auto` respectively.
 */
export class OrcaRouterProvider extends OpenAIChatCompletionProvider {
  constructor(config: ProviderConfig, aiSessionManager: AISessionManager) {
    super(config, aiSessionManager);
  }

  override getProviderName(): string {
    return "orcarouter";
  }

  protected override sessionProviderTag(): AIProviderType {
    return "orcarouter";
  }

  /**
   * Resolve the OpenAI-compatible endpoint.
   *
   * Defaults to the OrcaRouter gateway when `memoryApiUrl` is not configured,
   * so a minimal config only needs `memoryProvider` + `memoryApiKey`.
   */
  override resolveEndpoint(): string {
    const base = (this.config.apiUrl || "").trim().replace(/\/+$/, "");
    return base || ORCAROUTER_API_URL;
  }

  /**
   * Resolve the model ID to send to the gateway.
   *
   * Defaults to the `orcarouter/auto` routing alias when `memoryModel` is not
   * configured. OrcaRouter rejects bare model names (e.g. `gpt-4o-mini`), so a
   * namespaced ID is required — fail with a helpful message instead of a
   * gateway-side `model_not_found` error.
   */
  override resolveModel(): string {
    const model = (this.config.model || "").trim();
    if (!model) {
      return ORCAROUTER_DEFAULT_MODEL;
    }
    if (!model.includes("/")) {
      throw new Error(
        `OrcaRouter requires a namespaced memoryModel (e.g. "orcarouter/auto", "openai/gpt-5.5", "deepseek/deepseek-v4-flash"). Got: ${model}`
      );
    }
    return model;
  }
}
