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
