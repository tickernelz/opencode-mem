# GitHub Copilot Integration Strategy for opencode-mem Auto-Capture

## Executive Summary

This document outlines a strategy for enabling GitHub Copilot as a provider for opencode-mem's auto-capture feature. Currently, auto-capture only supports OpenAI, Anthropic, and Groq APIs directly via API tokens. The goal is to leverage the GitHub Copilot authentication and API access that opencode already provides.

## Problem Statement

The opencode-mem auto-capture system requires an external AI provider to analyze conversations and extract memories. Currently:

- **Supported providers**: `openai-chat`, `openai-responses`, `anthropic`
- **Configuration requirement**: Direct API keys (`memoryApiKey`)
- **Limitation**: Cannot use GitHub Copilot model services that opencode users already have access to

Users who only have GitHub Copilot access (no direct OpenAI/Anthropic API keys) cannot use auto-capture.

---

## Current Architecture Analysis

### opencode-mem Auto-Capture System

**Entry Point**: `src/services/auto-capture.ts`

```typescript
// Line 250 - Provider instantiation
const provider = AIProviderFactory.createProvider(CONFIG.memoryProvider, providerConfig);
```

**Provider Factory**: `src/services/ai/ai-provider-factory.ts`

```typescript
static createProvider(providerType: AIProviderType, config: ProviderConfig): BaseAIProvider {
  switch (providerType) {
    case "openai-chat":
      return new OpenAIChatCompletionProvider(config, aiSessionManager);
    case "openai-responses":
      return new OpenAIResponsesProvider(config, aiSessionManager);
    case "anthropic":
      return new AnthropicMessagesProvider(config, aiSessionManager);
    default:
      throw new Error(`Unknown provider type: ${providerType}`);
  }
}
```

**Base Provider Contract**: `src/services/ai/providers/base-provider.ts`

```typescript
export abstract class BaseAIProvider {
  abstract executeToolCall(
    systemPrompt: string,
    userPrompt: string,
    toolSchema: any,
    sessionId: string
  ): Promise<ToolCallResult>;

  abstract getProviderName(): string;
  abstract supportsSession(): boolean;
}
```

### opencode GitHub Copilot Integration

**Authentication**: `packages/opencode/src/plugin/copilot.ts`

- OAuth device flow authentication with GitHub
- Stores OAuth token as `refresh` token
- Supports both GitHub.com and GitHub Enterprise

**Key Authentication Pattern**:

```typescript
// Headers for Copilot API requests (line 121-139)
const headers: Record<string, string> = {
  "x-initiator": isAgent ? "agent" : "user",
  "User-Agent": `opencode/${Installation.VERSION}`,
  Authorization: `Bearer ${info.refresh}`, // OAuth token, NOT API key
  "Openai-Intent": "conversation-edits",
};
```

**API Endpoint**:

- Default: `https://api.githubcopilot.com` (implicit)
- Enterprise: `https://copilot-api.${domain}`

**Provider SDK**: `packages/opencode/src/provider/sdk/openai-compatible/`

- OpenAI-compatible client wrapper
- Supports both Chat Completions and Responses API
- Custom fetch implementation for header injection

---

## Proposed Solution Options

### Option A: Direct API Integration (Recommended)

Create a new `GitHubCopilotProvider` that directly calls the GitHub Copilot API using OAuth authentication obtained from opencode's auth system.

**Pros**:

- Self-contained within opencode-mem
- No runtime dependency on opencode internals
- Clean separation of concerns

**Cons**:

- Need to implement OAuth token retrieval from opencode's auth store
- Duplicates some Copilot API knowledge

**Implementation Approach**:

1. Read OAuth token from opencode's auth storage
2. Implement OpenAI-compatible API calls with Copilot headers
3. Handle tool calling via standard OpenAI Chat Completions format

### Option B: Leverage opencode Plugin Context

Use the `ctx.client` plugin context that opencode-mem already receives to access authenticated model services.

**Pros**:

- Leverages existing authentication
- No need to understand Copilot API internals
- Follows opencode's provider abstraction

**Cons**:

- Requires understanding opencode's SDK client API
- May have limitations on available operations
- Dependency on opencode internal APIs

### Option C: Hybrid Approach (Most Practical)

Obtain the OAuth token from opencode's auth system, then make direct OpenAI-compatible API calls with proper Copilot headers.

**Pros**:

- Uses established authentication
- Direct control over API calls
- Simplest implementation path

**Cons**:

- Depends on opencode auth storage format stability

---

## Recommended Implementation: Option C (Hybrid)

### Phase 1: Authentication Integration

**Task 1.1**: Create auth token retrieval mechanism

opencode stores authentication in its data directory. The auth system uses:

- Provider ID: `github-copilot` or `github-copilot-enterprise`
- Token type: OAuth (`info.type === "oauth"`)
- Token field: `info.refresh` (the OAuth access token)

```typescript
// src/services/ai/providers/github-copilot-auth.ts
import { homedir } from "node:os";
import { join } from "node:path";

interface CopilotAuth {
  token: string;
  enterpriseUrl?: string;
}

export async function getCopilotAuth(): Promise<CopilotAuth | null> {
  // Read from opencode's auth storage
  // Location: ~/.local/share/opencode/data.db (SQLite)
  // Or via opencode SDK if available
}
```

**Task 1.2**: Handle auth storage location differences

- Linux: `~/.local/share/opencode/`
- macOS: `~/Library/Application Support/opencode/`
- Windows: `%APPDATA%/opencode/`

### Phase 2: Provider Implementation

**Task 2.1**: Create GitHubCopilotProvider class

```typescript
// src/services/ai/providers/github-copilot.ts
import { BaseAIProvider, type ToolCallResult, type ProviderConfig } from "./base-provider.js";
import { AISessionManager } from "../session/ai-session-manager.js";
import type { ChatCompletionTool } from "../tools/tool-schema.js";
import { getCopilotAuth } from "./github-copilot-auth.js";

export class GitHubCopilotProvider extends BaseAIProvider {
  private aiSessionManager: AISessionManager;

  constructor(config: ProviderConfig, aiSessionManager: AISessionManager) {
    super(config);
    this.aiSessionManager = aiSessionManager;
  }

  getProviderName(): string {
    return "github-copilot";
  }

  supportsSession(): boolean {
    return true;
  }

  async executeToolCall(
    systemPrompt: string,
    userPrompt: string,
    toolSchema: ChatCompletionTool,
    sessionId: string
  ): Promise<ToolCallResult> {
    const auth = await getCopilotAuth();
    if (!auth) {
      return {
        success: false,
        error:
          "GitHub Copilot authentication not found. Please authenticate with 'opencode auth github-copilot'",
      };
    }

    // Build API URL
    const baseUrl = auth.enterpriseUrl
      ? `https://copilot-api.${auth.enterpriseUrl}`
      : "https://api.githubcopilot.com";

    // Follow OpenAI Chat Completions pattern with Copilot headers
    // ... (similar to OpenAIChatCompletionProvider)
  }

  private getCopilotHeaders(auth: CopilotAuth): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.token}`,
      "User-Agent": "opencode-mem/1.0",
      "Openai-Intent": "conversation-edits",
      "x-initiator": "agent",
    };
  }
}
```

**Task 2.2**: Register provider in factory

```typescript
// src/services/ai/ai-provider-factory.ts
import { GitHubCopilotProvider } from "./providers/github-copilot.js";

// Add to switch statement:
case "github-copilot":
  return new GitHubCopilotProvider(config, aiSessionManager);
```

### Phase 3: Configuration Updates

**Task 3.1**: Update config types

```typescript
// src/config.ts - Line 40
memoryProvider?: "openai-chat" | "openai-responses" | "anthropic" | "github-copilot";
```

**Task 3.2**: Update session types

```typescript
// src/services/ai/session/session-types.ts
export type AIProviderType = "openai-chat" | "openai-responses" | "anthropic" | "github-copilot";
```

**Task 3.3**: Update config template documentation

```jsonc
// In CONFIG_TEMPLATE (src/config.ts)
// GitHub Copilot (uses opencode authentication):
//   "memoryProvider": "github-copilot"
//   "memoryModel": "gpt-4o"  // or "claude-sonnet-4", "claude-opus-4", etc.
//   // No memoryApiUrl or memoryApiKey needed - uses opencode auth
```

### Phase 4: Model Support

GitHub Copilot provides access to multiple AI models from various providers. The implementation should support the full range of models available through the Copilot API.

#### Available Models via GitHub Copilot

**Anthropic Claude Models** (Recommended for auto-capture)

| Model ID            | Tier       | Use Case                                       | Notes                                        |
| ------------------- | ---------- | ---------------------------------------------- | -------------------------------------------- |
| `claude-opus-4.5`   | Premium    | Complex reasoning, architecture, deep analysis | Highest capability, expensive                |
| `claude-sonnet-4.5` | Standard   | General-purpose coding, reviews, multimodal    | Good balance of capability and cost          |
| `claude-haiku-4.5`  | Fast/Cheap | **Auto-capture (recommended)**, quick tasks    | Fast, cheap, excellent for memory extraction |

**Google Gemini Models**

| Model ID         | Tier    | Use Case                               | Notes                                |
| ---------------- | ------- | -------------------------------------- | ------------------------------------ |
| `gemini-3-pro`   | Premium | Creative tasks, complex reasoning      | Strong multimodal, good for artistry |
| `gemini-3-flash` | Fast    | Quick multimodal tasks, image analysis | Fast multimodal processing           |

**OpenAI Models**

| Model ID        | Tier       | Use Case                       | Notes                          |
| --------------- | ---------- | ------------------------------ | ------------------------------ |
| `gpt-4o`        | Standard   | General-purpose, balanced      | Good all-around choice         |
| `gpt-4o-mini`   | Fast/Cheap | Quick tasks, simple extraction | Alternative to Haiku for speed |
| `gpt-5.2-codex` | Premium    | Advanced coding tasks          | May have limited availability  |

#### Model Naming Convention

**IMPORTANT**: GitHub Copilot uses dot notation (e.g., `claude-sonnet-4.5`), NOT hyphen notation (e.g., `claude-sonnet-4-5`). The configuration must use the exact model ID format.

```jsonc
// CORRECT
"memoryModel": "claude-haiku-4.5"

// WRONG - will fail
"memoryModel": "claude-haiku-4-5"
```

#### Recommended Model for Auto-Capture

For memory extraction (auto-capture), we recommend **`claude-haiku-4.5`** because:

1. **Fast** - Memory extraction doesn't need deep reasoning, just pattern recognition
2. **Cheap** - Auto-capture runs frequently; minimizes Copilot usage quota
3. **Reliable** - Claude models have excellent tool calling support
4. **Sufficient** - Haiku-class models are more than capable for structured extraction

Alternative recommendations by priority:

1. `claude-haiku-4.5` (primary - Anthropic fast tier)
2. `gpt-4o-mini` (backup - OpenAI fast tier)
3. `claude-sonnet-4.5` (if higher quality extraction needed)

#### Model Configuration Examples

```jsonc
// Recommended: Fast and cheap for auto-capture
{
  "memoryProvider": "github-copilot",
  "memoryModel": "claude-haiku-4.5"
}

// Alternative: OpenAI fast tier
{
  "memoryProvider": "github-copilot",
  "memoryModel": "gpt-4o-mini"
}

// Premium: For users wanting highest quality extraction
{
  "memoryProvider": "github-copilot",
  "memoryModel": "claude-sonnet-4.5"
}
```

#### Model Availability Notes

1. **Subscription Tier**: Model availability depends on user's Copilot subscription (Individual, Business, Enterprise)
2. **Rate Limits**: Each model has different rate limits; Haiku/mini tiers are more generous
3. **Enterprise**: GitHub Enterprise may have different model availability
4. **Fallback**: Consider implementing fallback chain (e.g., `haiku-4.5` → `gpt-4o-mini` → `sonnet-4.5`)

#### oh-my-opencode Model Usage Patterns (Reference)

From real-world usage in oh-my-opencode configuration:

| Agent/Category          | Model Used          | Rationale                           |
| ----------------------- | ------------------- | ----------------------------------- |
| sisyphus (orchestrator) | `claude-opus-4.5`   | Main interface needs max capability |
| oracle (consultant)     | `claude-opus-4.5`   | Complex architecture decisions      |
| librarian (docs)        | `claude-haiku-4.5`  | Research tasks - speed over power   |
| explore (grep)          | `claude-haiku-4.5`  | Fast background exploration         |
| multimodal-looker       | `claude-sonnet-4.5` | Good multimodal understanding       |
| prometheus (planning)   | `claude-opus-4.5`   | Strategic planning needs depth      |
| quick (trivial)         | `claude-haiku-4.5`  | Simple tasks - fast and cheap       |
| writing (docs)          | `claude-haiku-4.5`  | Natural language tasks              |
| artistry (creative)     | `gemini-3-pro`      | Creative/unconventional solutions   |
| ultrabrain (logic)      | `claude-opus-4.5`   | Complex reasoning                   |

**Takeaway**: Auto-capture aligns with `librarian`, `explore`, `quick`, and `writing` patterns → **`claude-haiku-4.5` is the right choice**.

### Phase 5: Testing & Validation

**Task 5.1**: Unit tests for auth retrieval
**Task 5.2**: Integration tests with mock Copilot API
**Task 5.3**: End-to-end test with real Copilot auth

---

## Technical Considerations

### Authentication Token Access

The main challenge is accessing opencode's stored authentication. Options:

1. **Direct SQLite access**: Read from opencode's `data.db`
   - Fragile: schema changes could break
   - Location varies by platform

2. **opencode SDK client**: Use `ctx.client` if auth info is exposed
   - Need to verify available APIs
   - Cleaner integration

3. **Environment variable**: User exports token manually
   - Simple but poor UX
   - Token rotation issues

**Recommendation**: Start with direct SQLite access, abstract behind an interface for future SDK integration.

### API Compatibility

GitHub Copilot API is OpenAI-compatible with additional headers. The existing `OpenAIChatCompletionProvider` logic can be largely reused:

- Same request/response format
- Same tool calling format
- Different authentication headers
- Different base URL

### Error Handling

Specific error cases to handle:

1. **No Copilot auth**: Guide user to authenticate via opencode
2. **Token expired**: Refresh not typically needed (long-lived OAuth token)
3. **Model not available**: User's subscription may not include requested model
4. **Rate limiting**: Copilot has rate limits, need backoff logic

### Enterprise Support

For GitHub Enterprise users:

- Store and use `enterpriseUrl` from auth
- Construct correct API URL: `https://copilot-api.${domain}`

---

## Implementation Checklist

### Files to Create

- [ ] `src/services/ai/providers/github-copilot.ts` - Main provider class
- [ ] `src/services/ai/providers/github-copilot-auth.ts` - Auth retrieval

### Files to Modify

- [ ] `src/config.ts` - Add `"github-copilot"` to provider type union (lines 40, 84, 411-414)
- [ ] `src/services/ai/ai-provider-factory.ts` - Add case for github-copilot
- [ ] `src/services/ai/session/session-types.ts` - Add to AIProviderType
- [ ] `src/types/index.ts` - Add to AIProviderType if defined there

### Configuration Changes

- [ ] Update CONFIG_TEMPLATE with github-copilot documentation
- [ ] Add example configuration in README

### Testing

- [ ] Unit tests for GitHubCopilotProvider
- [ ] Auth retrieval tests (mock SQLite)
- [ ] Integration test with mock API

---

## Risk Assessment

| Risk                        | Likelihood | Impact | Mitigation                                      |
| --------------------------- | ---------- | ------ | ----------------------------------------------- |
| Auth storage format changes | Medium     | High   | Abstract behind interface, version check        |
| Copilot API changes         | Low        | Medium | Follow OpenAI-compatible patterns               |
| Tool calling not supported  | Low        | High   | Verify tool calling works before implementation |
| Rate limiting               | Medium     | Low    | Implement exponential backoff                   |

---

## Open Questions

1. **Does GitHub Copilot API support tool/function calling?**
   - Need to verify before implementation
   - If not, alternative memory extraction approach needed

2. **Can we access auth via opencode plugin context?**
   - Would be cleaner than direct SQLite access
   - Need to review opencode SDK documentation

3. ~~**What models are available for auto-capture use cases?**~~
   - ✅ **RESOLVED**: See Phase 4 for comprehensive model list
   - Recommended: `claude-haiku-4.5` (fast, cheap, excellent tool calling)
   - Full model availability documented with tier classifications

---

## Timeline Estimate

| Phase                            | Duration      | Dependencies                |
| -------------------------------- | ------------- | --------------------------- |
| Phase 1: Auth Integration        | 2-3 days      | opencode auth investigation |
| Phase 2: Provider Implementation | 2-3 days      | Phase 1                     |
| Phase 3: Configuration           | 1 day         | Phase 2                     |
| Phase 4: Model Support           | 1 day         | Phase 2                     |
| Phase 5: Testing                 | 2-3 days      | All phases                  |
| **Total**                        | **8-11 days** |                             |

---

## Appendix: Reference Files

### opencode Copilot Plugin

- `/Users/akinard/Sync/opencode/packages/opencode/src/plugin/copilot.ts`

### opencode Provider System

- `/Users/akinard/Sync/opencode/packages/opencode/src/provider/provider.ts`
- `/Users/akinard/Sync/opencode/packages/opencode/src/provider/sdk/openai-compatible/`

### opencode-mem Provider System

- `/Users/akinard/Sync/opencode-mem/src/services/ai/ai-provider-factory.ts`
- `/Users/akinard/Sync/opencode-mem/src/services/ai/providers/base-provider.ts`
- `/Users/akinard/Sync/opencode-mem/src/services/ai/providers/openai-chat-completion.ts`

### oh-my-opencode Copilot Patterns

- `/Users/akinard/Sync/oh-my-opencode/src/cli/model-fallback.ts`
- `/Users/akinard/Sync/oh-my-opencode/src/shared/model-requirements.ts`
