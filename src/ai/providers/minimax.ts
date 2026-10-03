import { type ProviderConfig } from "./base-provider.js";
import { AISessionManager } from "../session/ai-session-manager.js";
import { AnthropicMessagesProvider } from "./anthropic-messages.js";
import type { AIProviderType } from "../session/session-types.js";

/**
 * MiniMax provider.
 *
 * MiniMax exposes an Anthropic Messages-compatible endpoint for its text
 * models. The global endpoint (https://api.minimax.io) and the China endpoint
 * (https://api.minimaxi.com) both expose the same `/anthropic/v1/messages`
 * path and authenticate with the `x-api-key` header. This provider reuses the
 * Anthropic Messages request/response handling and only overrides the resolved
 * request endpoint URL and the session provider tag, so MiniMax is
 * distinguishable from Anthropic in the session store and diagnostics.
 *
 * Users configure the base URL as `memoryApiUrl`:
 *   - global endpoint: "https://api.minimax.io"
 *   - China endpoint:  "https://api.minimaxi.com"
 */
export class MiniMaxProvider extends AnthropicMessagesProvider {
  constructor(config: ProviderConfig, aiSessionManager: AISessionManager) {
    super(config, aiSessionManager);
  }

  override getProviderName(): string {
    return "minimax";
  }

  /**
   * Resolve the Anthropic Messages endpoint URL for MiniMax.
   *
   * MiniMax's Messages endpoint lives at `<base>/anthropic/v1/messages`. The
   * base URL is normalized so users can supply the host with or without a
   * trailing `/anthropic`, `/anthropic/v1`, or `/anthropic/v1/messages` suffix.
   */
  override resolveEndpoint(): string {
    let base = (this.config.apiUrl || "").trim().replace(/\/+$/, "");
    if (!base) {
      throw new Error("MiniMax provider requires a configured memoryApiUrl");
    }
    base = base.replace(/\/anthropic\/v1\/messages\/?$/, "");
    base = base.replace(/\/anthropic\/v1\/?$/, "");
    base = base.replace(/\/anthropic\/?$/, "");
    return `${base}/anthropic/v1/messages`;
  }

  override sessionProviderTag(): AIProviderType {
    return "minimax";
  }

  protected override apiErrorLogLabel(): string {
    return "MiniMax Messages API error";
  }

  protected override toolValidationErrorLogLabel(): string {
    return "MiniMax tool response validation failed";
  }

  protected override timeoutLabel(): string {
    return "MiniMax API request timeout";
  }
}
