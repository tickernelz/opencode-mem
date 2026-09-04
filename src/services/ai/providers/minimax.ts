import { type ProviderConfig } from "./base-provider.js";
import { AISessionManager } from "../session/ai-session-manager.js";
import { AnthropicMessagesProvider } from "./anthropic-messages.js";
import type { AIProviderType } from "../session/session-types.js";

export interface MiniMaxModelMetadata {
  contextWindow: number;
  pricingUsdPerMillionTokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number | null;
  };
  inputModalities: readonly string[];
  thinkingModes: readonly string[];
}

/** Current text model capabilities and pricing. */
export const MINIMAX_MODEL_METADATA = {
  "MiniMax-M3": {
    contextWindow: 1_000_000,
    pricingUsdPerMillionTokens: {
      input: 0.6,
      output: 2.4,
      cacheRead: 0.12,
      cacheWrite: null,
    },
    inputModalities: ["text", "image", "video"],
    thinkingModes: ["adaptive", "disabled"],
  },
  "MiniMax-M2.7": {
    contextWindow: 204_800,
    pricingUsdPerMillionTokens: {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.06,
      cacheWrite: 0.375,
    },
    inputModalities: ["text"],
    thinkingModes: ["always_on"],
  },
} as const satisfies Record<string, MiniMaxModelMetadata>;

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
