import type { SharedRuntimeClient } from "./client.js";

/**
 * Shared-process attach bridge for OpenCode.
 *
 * `runtime/` owns the shared-process boundary: HTTP client, runtime HTTP routes,
 * and this in-process pointer used when the plugin attaches to a healthy `serve`.
 * When set, tools and auto-capture writes go through the bridge instead of
 * opening a second Turso/embedding owner in-process.
 */
let sharedBridge: SharedRuntimeClient | null = null;
let sharedBaseUrl: string | null = null;

export function setSharedRuntimeBridge(
  client: SharedRuntimeClient | null,
  baseUrl: string | null = null
): void {
  sharedBridge = client;
  sharedBaseUrl = client ? (baseUrl ?? client.baseUrl) : null;
}

export function getSharedRuntimeBridge(): SharedRuntimeClient | null {
  return sharedBridge;
}

export function getSharedRuntimeBaseUrl(): string | null {
  return sharedBaseUrl;
}

export function isUsingSharedRuntime(): boolean {
  return sharedBridge !== null;
}
