# Security Audit — opencode-mem

**Scope:** `tickernelz/opencode-mem` @ commit `0998c69` (main). Local HTTP API, CORS policy, secret handling, SQLite layer, web UI, config/JSONC parsing, migration/cleanup services, dependencies. Read-only audit followed by targeted fixes for the three highest-severity findings.

## Findings

### 1. CRITICAL — Path traversal via unauthenticated `containerTag` (fixed)

`extractScopeFromTag()` in `src/services/api-handlers.ts` split the client-supplied `containerTag` on `_` and used everything after the second `_` as a `hash`, with no character validation. That hash was concatenated into a shard filename in `shard-manager.ts:getShardPath()` and passed through `path.join()`, then `connection-manager.ts:getConnection()` created any missing parent directories and opened/created a SQLite database at the resulting path.

A request such as `POST /api/memories {"content":"x","containerTag":"project_x_../../../../../../Temp/pwn"}` creates directories and a SQLite file outside `~/.opencode-mem/data`. The same unsanitized parsing was duplicated in `migration-service.ts`'s re-embed path.

**Fix:** `extractScopeFromTag()` now validates the hash segment against `^[a-zA-Z0-9]+$` (matching the sha256-hex format the plugin itself always generates) and throws on anything else; the duplicate parsing in `migration-service.ts` got the same guard. Regression test: `tests/api-handlers-container-tag-traversal.test.ts`.

### 2. HIGH — No authentication on the local HTTP API (fixed)

CORS was being used as a substitute for authentication in `src/services/cors.ts`, but `isAllowedBrowserOrigin()` returned `true` whenever no `Origin` header was present — which is the case for `curl`, other local processes, and any non-browser client. Every `/api/*` handler (read/write/delete memories, full user-profile CRUD, migrations) had no session/token check at all. If `webServerHost` is set to `0.0.0.0` (a documented config option), this is reachable from the whole LAN with no auth.

**Fix:** added `src/services/auth-token.ts` — a random 256-bit token generated on first run, persisted to `~/.opencode-mem/.auth-token` (mode `0600`), required via the `x-opencode-mem-token` header on every `/api/*` request in both `web-server.ts` and `web-server-worker.ts`. The token is injected into the server-rendered `index.html` (`window.__OPENCODE_MEM_TOKEN__`) so the bundled web UI keeps working transparently (`app.js:fetchAPI` now sends the header), while a malicious cross-origin web page cannot read it (opaque/no-cors responses). The internal `checkServerAvailable()` health-check call was updated to send the token too, so the existing takeover/health-check logic still works.

This does not fully replace a "don't expose to `0.0.0.0` without more" warning — see recommendation below — but it closes the CSRF-style "any web page or generic local process can drive the API" gap the CORS check alone did not.

### 3. HIGH — Stored XSS via unescaped `profile.displayName` (fixed)

`renderUserProfile()` in `src/web/app.js` injected `profile.displayName` into `innerHTML` with no `escapeHtml()` call, unlike every other user-influenced field rendered elsewhere in the same file. `displayName` originates from `userNameOverride` in a project's `.opencode/opencode-mem.jsonc`, which is loaded automatically, with no confirmation, whenever that project is opened — so a malicious repo can plant a payload that later executes in the local Web UI when the profile tab is viewed, with same-origin `fetch()` access to the (now-authenticated, but still same-origin) API.

The existing `tests/web-memorytype-xss.test.ts` covers a different field (`memoryType`) that was already escaped correctly; it did not cover this sink.

**Fix:** wrapped the value in `escapeHtml()`. Regression test: `tests/web-userprofile-xss.test.ts` (fails against the pre-fix code, passes after).

### 4. MEDIUM — Unpinned, non-SRI third-party scripts (not fixed — recommendation only)

`src/web/index.html` loads `lucide@latest` and `jsonrepair@latest` (no version pin) plus two pinned-but-no-`integrity` scripts from `unpkg.com`/`cdn.jsdelivr.net`. Recommend pinning exact versions and adding Subresource Integrity hashes, or self-hosting alongside the already-vendored `app.js`/`i18n.js`/`styles.css`.

### 5. LOW / informational — Gemini API key in URL query string (not fixed)

`src/services/ai/providers/google-gemini.ts` sends the API key as a `?key=` query parameter, per Google's own Gemini REST API design (not a defect introduced by this plugin). No exploitable leak found in this codebase's own logging.

## Areas checked with no exploitable findings

- SQL construction in `src/services/sqlite/*` — parameterized queries throughout.
- `src/services/jsonc.ts` — comment-stripping + `JSON.parse`, no injection surface.
- Config merge (`src/config.ts`) — plain object spread, not vulnerable to `__proto__` prototype pollution.
- No `eval`/`new Function`/shell injection; the only `execSync` calls use fixed command strings.
- `secret-resolver.ts` — no endpoint echoes `memoryApiKey`/`embeddingApiKey` back to callers.

## Remaining recommendations (not implemented in this patch)

- Pin and add SRI to the CDN-loaded scripts in `src/web/index.html` (Finding 4).
- Consider warning (or refusing) at startup when `webServerHost` is set to a non-loopback address without additional network-level protection, since the token-based fix here raises the bar but a determined local/LAN attacker who can read `~/.opencode-mem/.auth-token` (or intercept the injected `<script>` in `index.html` over the LAN) still obtains it.
- Broader sweep of `src/web/app.js` for any other unescaped `innerHTML` sinks beyond the ones checked here, the same way `web-memorytype-xss.test.ts` covered `memoryType`.

## Verification performed

- `bun install && bunx tsc --noEmit` — no type errors introduced.
- `bun test` — all pre-existing passing tests remain green; the two new regression test files (7 test cases) pass against the patched code and were confirmed to fail against the pre-patch code. Unrelated failures in this sandbox (`EPERM` on `~/.opencode-mem/opencode-mem.log`, and `dist/plugin.js`-dependent tests requiring `bun run build`) are pre-existing environment conditions, not caused by this patch — verified by running the full suite on an unpatched `git stash` checkout, which showed the same failures.
