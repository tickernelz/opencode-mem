# AI service agent guide

## Scope

- `src/services/ai/` owns provider selection, OpenCode auth reuse, provider-specific request shaping, and SQLite-backed AI session persistence.

## Where to look

- `ai-provider-factory.ts` — provider registry and the supported provider list.
- `providers/base-provider.ts` — `BaseAIProvider`, `ProviderConfig`, and `applySafeExtraParams()` with protected request keys.
- `provider-config.ts` — builds external API config from runtime config.
- `opencode-provider.ts` — bridges OpenCode auth state into Anthropic/OpenAI SDK providers and structured output helpers.
- `session/ai-session-manager.ts` — persists provider sessions and messages in `ai-sessions.db`.
- `validators/user-profile-validator.ts` — depends on user-profile types outside this subtree.

## Conventions

- New providers must implement `BaseAIProvider`, then be registered in `AIProviderFactory.createProvider()` and `getSupportedProviders()`.
- Preserve `applySafeExtraParams()` filtering. Keys like `model`, `messages`, `tools`, `input`, and `conversation` are intentionally protected from override.
- Session-aware providers share `aiSessionManager`; do not create ad hoc session stores.
- `opencode-provider.ts` supports OpenCode-managed auth. Anthropic OAuth refresh and tool-name prefix rewriting are intentional compatibility code, not dead weight.
- `aiSessionManager` stores sessions separately from memory shards in `ai-sessions.db`; keep that separation.

## Gotchas

- `opencode-provider.ts` expects plugin init to call `setStatePath()` and `setConnectedProviders()` before OpenCode-backed provider work.
- OpenAI does not support the OAuth path implemented for Anthropic; preserve that guardrail.
- Session retention comes from `CONFIG.aiSessionRetentionDays`; expiry behavior is configuration-driven.
- Cross-subtree dependency: validators can import user-profile types. If those types move, update the validator path too.

## Change checklist

- Adding a provider: provider class, factory registration, tests, and any provider-specific request/response normalization.
- Changing provider config: update `provider-config.ts` and confirm the new fields do not bypass protected request keys.
- Changing session schema: update `ai-session-manager.ts` carefully; this subsystem uses real SQLite tables, not in-memory state.
