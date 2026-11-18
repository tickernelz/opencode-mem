/** Default abort deadline for external (manual API) profile cleanup. */
export const EXTERNAL_PROFILE_CLEANUP_TIMEOUT_MS = 60_000;

/** Abort deadline for OpenCode-session profile cleanup. */
export const OPENCODE_PROFILE_CLEANUP_TIMEOUT_MS = 300_000;

const HTTP_TIMEOUT_GRACE_MS = 30_000;

/**
 * Max clamp for `userProfileCleanupTimeoutMs` (and the Web UI fetch budget for
 * `/ai-cleanup`). Keep the browser timeout at least this high so a raised
 * backend deadline is never undercut by the frontend.
 */
export const USER_PROFILE_CLEANUP_TIMEOUT_MS_MAX = 600_000;

/** Web UI fetch timeout for POST `/ai-cleanup` (covers max backend + grace). */
export const WEB_AI_CLEANUP_FETCH_TIMEOUT_MS =
  USER_PROFILE_CLEANUP_TIMEOUT_MS_MAX + HTTP_TIMEOUT_GRACE_MS;

/**
 * Node `server.timeout` must sit above every cleanup deadline so the HTTP idle
 * timer does not abort a still-running provider call.
 */
export function resolveNodeHttpIdleTimeoutMs(
  externalCleanupTimeoutMs: number = EXTERNAL_PROFILE_CLEANUP_TIMEOUT_MS
): number {
  return (
    Math.max(externalCleanupTimeoutMs, OPENCODE_PROFILE_CLEANUP_TIMEOUT_MS) + HTTP_TIMEOUT_GRACE_MS
  );
}

/** Default idle timeout when no config is loaded yet. */
export const NODE_HTTP_IDLE_TIMEOUT_MS = resolveNodeHttpIdleTimeoutMs();
