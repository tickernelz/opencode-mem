export function stripPrivateContent(content: string): string {
  return content.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED]");
}

export function isFullyPrivate(content: string): boolean {
  const stripped = stripPrivateContent(content).trim();
  return stripped === "[REDACTED]" || stripped === "";
}
