const PLACEHOLDER_API_KEYS = new Set([
  "sk-...",
  "sk-ant-...",
  "gsk_...",
  "your-api-key",
  "your api key",
  "replace-with-your-api-key",
]);

export function isPlaceholderApiKey(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return PLACEHOLDER_API_KEYS.has(value.trim().toLowerCase());
}
