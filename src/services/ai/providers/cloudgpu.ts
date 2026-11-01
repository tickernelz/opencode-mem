import { OpenAIChatCompletionProvider } from "./openai-chat-completion.js";
import type { ProviderConfig } from "./base-provider.js";
import type { AISessionManager } from "../session/ai-session-manager.js";
import type { AIProviderType } from "../session/session-types.js";

/** CloudGPU OpenAI-compatible endpoint used when `memoryApiUrl` is omitted. */
export const CLOUDGPU_API_URL = "https://cloudgpu.app/v1";

/**
 * Default model when `memoryModel` is omitted. CloudGPU model IDs are listed
 * at `https://cloudgpu.app/v1/models` and are sent unchanged (e.g. `deepseek-v4.1-flash`).
 */
export const CLOUDGPU_DEFAULT_MODEL = "deepseek-v4.1-flash";

/**
 * CloudGPU provider.
 *
 * [CloudGPU](https://cloudgpu.app) exposes an OpenAI-compatible Chat
 * Completions API. This provider reuses the OpenAI Chat Completions request
 * handling and only overrides the resolved endpoint, default model, and the
 * session provider tag, so CloudGPU sessions are distinguishable in the
 * session store and diagnostics.
 *
 * Users configure it as:
 *   "memoryProvider": "cloudgpu"
 *   "memoryApiKey": "env://CLOUDGPU_API_KEY"
 *
 * API keys are created at https://cloudgpu.app/api/console; API docs are at
 * https://cloudgpu.app/api/docs.
 *
 * `memoryApiUrl` and `memoryModel` are optional — they default to the CloudGPU endpoint and `deepseek-v4.1-flash` respectively.
 *
 * When this provider is selected, auto-capture / profile prompts, model
 * responses, and relevant conversation context are transmitted to
 * `https://cloudgpu.app`.
 */
export class CloudGPUProvider extends OpenAIChatCompletionProvider {
  constructor(config: ProviderConfig, aiSessionManager: AISessionManager) {
    super(config, aiSessionManager);
  }

  override getProviderName(): string {
    return "cloudgpu";
  }

  protected override sessionProviderTag(): AIProviderType {
    return "cloudgpu";
  }

  /**
   * Resolve the OpenAI-compatible endpoint.
   *
   * Defaults to the CloudGPU API when `memoryApiUrl` is not configured,
   * so a minimal config only needs `memoryProvider` + `memoryApiKey`.
   */
  override resolveEndpoint(): string {
    const base = (this.config.apiUrl || "").trim().replace(/\/+$/, "");
    return base || CLOUDGPU_API_URL;
  }

  /**
   * Resolve the model ID to send to CloudGPU.
   *
   * Defaults to `deepseek-v4.1-flash` when `memoryModel` is not configured.
   */
  override resolveModel(): string {
    const model = (this.config.model || "").trim();
    return model || CLOUDGPU_DEFAULT_MODEL;
  }
}
