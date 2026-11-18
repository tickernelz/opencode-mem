import { toast } from "$lib/toast/toast.svelte";
import type { ApiResult } from "$shared/api";
import { t, type TranslateFn } from "./i18n";

declare global {
  interface Window {
    __OPENCODE_MEM_TOKEN__?: string;
  }
}

export type { ApiResult };

function mergeHeaders(
  body: BodyInit | null | undefined,
  extra?: HeadersInit
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-opencode-mem-token": window.__OPENCODE_MEM_TOKEN__ || "",
  };
  if (body != null && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  if (extra) {
    const entries =
      extra instanceof Headers
        ? [...extra.entries()]
        : Array.isArray(extra)
          ? extra
          : Object.entries(extra);
    for (const [key, value] of entries) {
      if (value != null) headers[key] = String(value);
    }
  }
  return headers;
}

export async function fetchAPI<T = unknown>(
  endpoint: string,
  options: RequestInit & { timeout?: number } = {}
): Promise<ApiResult<T>> {
  try {
    const controller = new AbortController();
    // /ai-cleanup must outlive userProfileCleanupTimeoutMs (max 600s) + server grace.
    const timeoutMs =
      options.timeout ||
      (options.method === "POST" && endpoint.includes("/ai-cleanup") ? 630000 : 60000);
    const { timeout: _timeout, headers: extraHeaders, ...fetchOptions } = options;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(endpoint, {
      ...fetchOptions,
      headers: mergeHeaders(fetchOptions.body, extraHeaders),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return (await response.json()) as ApiResult<T>;
  } catch (error) {
    console.error("API Error:", error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

type ToastApiOptions = {
  success?: string;
  successKey?: string;
  failKey?: string;
  translate?: TranslateFn;
  onSuccess?: () => void | Promise<void>;
};

/** Shared success/error toast pattern for ApiResult. */
export async function toastApiResult(
  result: ApiResult,
  options: ToastApiOptions = {}
): Promise<boolean> {
  const tr = options.translate ?? t;
  if (result.success) {
    const message =
      options.success ||
      (options.successKey ? tr(options.successKey) : undefined) ||
      (typeof result.data === "object" &&
      result.data &&
      "message" in result.data &&
      typeof (result.data as { message?: unknown }).message === "string"
        ? (result.data as { message: string }).message
        : undefined);
    if (message) toast.success(message);
    await options.onSuccess?.();
    return true;
  }
  toast.error(result.error || (options.failKey ? tr(options.failKey) : "Request failed"));
  return false;
}
