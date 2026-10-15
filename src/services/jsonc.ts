/**
 * Strips comments from JSONC content while respecting string boundaries.
 * Handles // and /* comments, URLs in strings, and escaped quotes.
 * Also removes trailing commas to support more relaxed JSONC format.
 */
export function stripJsoncComments(content: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  let inSingleLineComment = false;
  let inMultiLineComment = false;

  while (i < content.length) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (!inSingleLineComment && !inMultiLineComment) {
      if (char === '"') {
        // Count consecutive backslashes before this quote
        let backslashCount = 0;
        let j = i - 1;
        while (j >= 0 && content[j] === "\\") {
          backslashCount++;
          j--;
        }
        // Quote is escaped only if preceded by ODD number of backslashes
        // e.g., \" = escaped, \\" = not escaped (escaped backslash + quote)
        if (backslashCount % 2 === 0) {
          inString = !inString;
        }
        result += char;
        i++;
        continue;
      }
    }

    if (inString) {
      result += char;
      i++;
      continue;
    }

    if (!inSingleLineComment && !inMultiLineComment) {
      if (char === "/" && nextChar === "/") {
        inSingleLineComment = true;
        i += 2;
        continue;
      }

      if (char === "/" && nextChar === "*") {
        inMultiLineComment = true;
        i += 2;
        continue;
      }
    }

    if (inSingleLineComment) {
      if (char === "\n") {
        inSingleLineComment = false;
        result += char;
      }
      i++;
      continue;
    }

    if (inMultiLineComment) {
      if (char === "*" && nextChar === "/") {
        inMultiLineComment = false;
        i += 2;
        continue;
      }
      if (char === "\n") {
        result += char;
      }
      i++;
      continue;
    }

    // Drop structural trailing commas (comma before } or ], allowing
    // whitespace and comments in between).
    if (char === "," && isTrailingComma(content, i)) {
      i++;
      continue;
    }

    result += char;
    i++;
  }

  return result;
}

/** True when the comma at `commaIndex` is followed only by whitespace/comments then } or ]. */
function isTrailingComma(content: string, commaIndex: number): boolean {
  let next = commaIndex + 1;
  while (next < content.length) {
    const c = content.charAt(next);
    const n = content.charAt(next + 1);

    if (/\s/.test(c)) {
      next++;
      continue;
    }

    if (c === "/" && n === "/") {
      next += 2;
      while (next < content.length && content.charAt(next) !== "\n") next++;
      continue;
    }

    if (c === "/" && n === "*") {
      next += 2;
      while (
        next + 1 < content.length &&
        !(content.charAt(next) === "*" && content.charAt(next + 1) === "/")
      ) {
        next++;
      }
      next += 2;
      continue;
    }

    return c === "}" || c === "]";
  }
  return false;
}
