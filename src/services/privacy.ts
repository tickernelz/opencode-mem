const REDACTED = "[REDACTED]";

// `<private>` / `</private>`, case-insensitive, tolerating whitespace inside the
// tag (`<private >`) the way an XML parser would.
const PRIVATE_TAG = /<(\/?)private\s*>/gi;

/**
 * Replace every `<private>…</private>` region with `[REDACTED]`.
 *
 * Scans tags with a depth counter rather than matching pairs with a single
 * regex, so that the two malformed shapes fail *closed*:
 *
 * - An **unclosed** `<private>` redacts to the end of the input. A non-greedy
 *   pair match found no closing tag and left the region untouched, so a typo or
 *   a truncated message stored the content verbatim.
 * - **Nested** tags close at the outer tag, not the first inner one. Pair
 *   matching ended the region at the inner `</private>`, releasing the rest of
 *   the outer region and leaving a stray `</private>` in the output.
 *
 * Erring toward redaction is the only safe direction here: the caller persists
 * this string, so a wrong guess in the other direction is an unrecoverable
 * disclosure, while over-redacting merely loses text the user can retype.
 *
 * A `</private>` with no opener is markup rather than content, so it is dropped
 * instead of being surfaced to the user as if it were part of their text.
 */
export function stripPrivateContent(content: string): string {
  if (!content.includes("<")) {
    return content;
  }

  let result = "";
  let depth = 0;
  let cursor = 0;

  PRIVATE_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = PRIVATE_TAG.exec(content)) !== null) {
    const isClosing = match[1] === "/";

    if (!isClosing) {
      if (depth === 0) {
        result += content.slice(cursor, match.index);
      }
      depth++;
      cursor = PRIVATE_TAG.lastIndex;
      continue;
    }

    if (depth === 0) {
      // Stray closing tag: emit the text before it, drop the tag itself.
      result += content.slice(cursor, match.index);
      cursor = PRIVATE_TAG.lastIndex;
      continue;
    }

    depth--;
    if (depth === 0) {
      result += REDACTED;
    }
    cursor = PRIVATE_TAG.lastIndex;
  }

  if (depth > 0) {
    // Unclosed region: everything from the opening tag onward stays private.
    return result + REDACTED;
  }

  return result + content.slice(cursor);
}

/**
 * True when nothing survives redaction — the caller refuses such a write rather
 * than storing a message that is private in its entirety.
 */
export function isFullyPrivate(content: string): boolean {
  const stripped = stripPrivateContent(content).trim();
  return stripped === REDACTED || stripped === "";
}

// Deliberately recognizable formats, not an entropy detector: commit hashes,
// checksums, UUIDs and opaque application IDs are useful memory context.
const CREDENTIAL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // GitHub now also issues stateless ghs_APPID_JWT installation tokens:
  // https://github.blog/changelog/2026-04-24-notice-about-upcoming-new-format-for-github-app-installation-tokens/
  [
    /(?<![\w-])ghs_[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![\w-])/g,
    "github-token",
  ],
  [/(?<![\w-])gh[pousr]_[A-Za-z0-9_]{36,}(?![\w-])/g, "github-token"],
  [/(?<![\w-])github_pat_[A-Za-z0-9_]{40,}(?![\w-])/g, "github-token"],
  [/(?<![\w-])sk-(?:proj-|svcacct-|ant-api\d+-)[A-Za-z0-9_-]{20,}(?![\w-])/g, "api-key"],
  [/(?<![\w-])sk-or-v1-[a-fA-F0-9]{64}(?![\w-])/g, "api-key"],
  [/(?<![\w-])sk-[A-Za-z0-9]{48}(?![\w-])/g, "api-key"],
  [/(?<![\w-])AIza[A-Za-z0-9_-]{35}(?![\w-])/g, "api-key"],
  [/(?<![\w-])xox[baprs]-[0-9]{6,}-[A-Za-z0-9-]{10,}(?![\w-])/g, "slack-token"],
  [/(?<![\w])(?:AKIA|ASIA)[A-Z0-9]{16}(?![\w])/g, "aws-access-key"],
];

// Keep the authorization scheme, key name and surrounding syntax useful. Do
// not consume expressions (process.env.KEY, ${KEY}, config.key), ordinary code
// identifiers or common placeholders. Require letters and at least four digits
// in quoted literals or uppercase environment assignments. Bare lowercase
// values can be code references or YAML literals, so leave them ambiguous.
// Custom/short/all-letter secrets are not
// inferred; callers can use <private> for values without a recognizable shape.
const CREDENTIAL_KEY_NAME = String.raw`(?:[\w]+[_-])?(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd)`;
const CREDENTIAL_KEY = new RegExp(`^${CREDENTIAL_KEY_NAME}$`, "i");
const CREDENTIAL_ASSIGNMENT = new RegExp(
  String.raw`\b(${CREDENTIAL_KEY_NAME}\b["']?\s*[:=]\s*)(["']?)([A-Za-z0-9_+/=-]{8,})\2(?![\w.+/-])`,
  "gi"
);

function isPlaceholder(value: string): boolean {
  return /^(?:YOUR_|REPLACE_|EXAMPLE_|TOKEN_PLACEHOLDER$)/.test(value);
}

function hasCredentialEvidence(value: string): boolean {
  return !isPlaceholder(value) && /[a-z]/i.test(value) && (value.match(/\d/g)?.length ?? 0) >= 4;
}

function isCredentialLiteral(value: string): boolean {
  return /^[A-Za-z0-9_+/=-]{8,}$/.test(value) && hasCredentialEvidence(value);
}
const BEARER = /\b(Bearer[ \t]+)([A-Za-z0-9._~+/-]{12,}=*)(?![\w.~+/-])/gi;

function redactPrivateKeys(content: string): string {
  // A recognizable opener without a matching end marker fails closed to EOF,
  // including a truncated opener missing its final dashes. Never retain a key
  // body merely because capture was bounded or the user pasted malformed PEM.
  const opener = /-----BEGIN ((?:[A-Z0-9]+ )?PRIVATE KEY)(?:-----)?/g;
  let result = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(content)) !== null) {
    result += content.slice(cursor, match.index) + "[REDACTED:private-key]";
    const endMarker = `-----END ${match[1]}-----`;
    const end = content.indexOf(endMarker, opener.lastIndex);
    if (end === -1) return result;
    cursor = end + endMarker.length;
    opener.lastIndex = cursor;
  }
  return result + content.slice(cursor);
}

/**
 * Best-effort protection for the plugin's memory text, before sending or saving
 * it. Not a universal secret detector and not protection for OpenCode's original
 * conversation or tool traffic. No raw matches are logged or retained.
 */
export function sanitizeMemoryContent(content: string): string {
  let result = redactPrivateKeys(stripPrivateContent(content));
  for (const [pattern, kind] of CREDENTIAL_PATTERNS) {
    result = result.replace(pattern, `[REDACTED:${kind}]`);
  }
  result = result.replace(BEARER, (match: string, prefix: string, value: string) =>
    hasCredentialEvidence(value) ? `${prefix}[REDACTED:bearer-token]` : match
  );
  return result.replace(
    CREDENTIAL_ASSIGNMENT,
    (match: string, prefix: string, quote: string, value: string, offset: number) =>
      (quote ||
        (/^[A-Z][A-Z0-9_]*\s*=\s*$/.test(prefix) &&
          /^\s*(?:export\s+)?$/.test(
            result.slice(result.lastIndexOf("\n", offset - 1) + 1, offset)
          ))) &&
      isCredentialLiteral(value)
        ? `${prefix}${quote}[REDACTED:credential]${quote}`
        : match
  );
}

/** JSON.stringify replacer: sanitize strings before escaping loses their syntax,
 * and retain credential field context for literal values (including nesting).
 * Other values pass through; serialization owns traversal, not this helper.
 */
export function sanitizeMemoryField(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (CREDENTIAL_KEY.test(key) && isCredentialLiteral(value)) {
    return "[REDACTED:credential]";
  }
  return sanitizeMemoryContent(value);
}
