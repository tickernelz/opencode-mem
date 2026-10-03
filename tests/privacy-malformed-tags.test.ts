import { describe, it, expect } from "bun:test";
import { stripPrivateContent, isFullyPrivate } from "../src/infra/privacy.js";

const SECRET = "sk-live-abc123";

/**
 * `stripPrivateContent` is the last thing between a `<private>` block and
 * persistent storage (`src/hosts/opencode/plugin.ts:548` for memories, `:612` for the user
 * profile). Malformed markup must fail *closed*: the caller writes the result to
 * a database, so under-redacting is an unrecoverable disclosure while
 * over-redacting only loses text the user can retype.
 */
describe("privacy: malformed <private> markup", () => {
  it("redacts to the end of input when the closing tag is missing", () => {
    // A pair-matching regex found no `</private>` and left the whole region
    // untouched, so a typo or a truncated message stored the secret verbatim.
    const result = stripPrivateContent(`my key is <private>${SECRET}`);

    expect(result).not.toContain(SECRET);
    expect(result).toBe("my key is [REDACTED]");
  });

  it("treats an unclosed tag as fully private when nothing else remains", () => {
    // The write path refuses fully-private content. Previously this returned
    // false, so the message was accepted *and* stored unredacted.
    expect(isFullyPrivate(`<private>${SECRET}`)).toBe(true);
  });

  it("redacts a region left unclosed by a truncated message", () => {
    const result = stripPrivateContent(`intro <private>${SECRET} and more text`);
    expect(result).not.toContain(SECRET);
    expect(result).not.toContain("and more text");
  });

  it("closes a nested region at the outer tag, not the first inner one", () => {
    // Pair matching stopped at the inner `</private>`, releasing the remainder of
    // the outer region and leaving a stray `</private>` in the stored text.
    const result = stripPrivateContent(
      `<private>outer <private>inner</private> ${SECRET}</private>`
    );

    expect(result).not.toContain(SECRET);
    expect(result).not.toContain("inner");
    expect(result).not.toContain("private>");
    expect(result).toBe("[REDACTED]");
  });

  it("handles whitespace inside the tag the way a parser would", () => {
    // `<private >` is the same tag; it previously matched nothing and passed
    // through verbatim.
    const result = stripPrivateContent(`<private >${SECRET}</private >`);

    expect(result).not.toContain(SECRET);
    expect(result).toBe("[REDACTED]");
  });

  it("drops a stray closing tag instead of surfacing it as content", () => {
    // With no opener there is nothing to redact, but the markup is not the user's
    // text either, so it should not be stored.
    expect(stripPrivateContent("visible </private> text")).toBe("visible  text");
  });

  it("keeps mixed-case tags working, including when unclosed", () => {
    expect(stripPrivateContent(`<PRIVATE>${SECRET}</private>`)).toBe("[REDACTED]");
    expect(stripPrivateContent(`<Private>${SECRET}`)).toBe("[REDACTED]");
  });

  it("redacts each well-formed region independently and keeps the text between", () => {
    // The fix must not merge separate regions; this is the behaviour the existing
    // suite relies on, asserted here alongside the malformed cases.
    const result = stripPrivateContent(`a <private>one</private> b <private>two</private> c`);
    expect(result).toBe("a [REDACTED] b [REDACTED] c");
  });

  it("leaves content with no tags untouched, including other angle brackets", () => {
    expect(stripPrivateContent("use Array<string> and a < b")).toBe("use Array<string> and a < b");
    expect(stripPrivateContent("")).toBe("");
    expect(stripPrivateContent("no markup at all")).toBe("no markup at all");
  });

  it("is not confused by a similarly named tag", () => {
    // Only `private` is the redaction tag; `<privateer>` is ordinary text.
    const input = "<privateer>ship</privateer>";
    expect(stripPrivateContent(input)).toBe(input);
  });

  it("does not leak across repeated calls", () => {
    // The tag regex is a module-level /g literal, so `lastIndex` has to be reset
    // per call or the second call would start mid-string and miss the tag.
    const input = `<private>${SECRET}</private>`;
    expect(stripPrivateContent(input)).toBe("[REDACTED]");
    expect(stripPrivateContent(input)).toBe("[REDACTED]");
    expect(stripPrivateContent(input)).toBe("[REDACTED]");
  });

  it("redacts an unclosed region that opens after a closed one", () => {
    const result = stripPrivateContent(`<private>first</private> middle <private>${SECRET}`);
    expect(result).not.toContain(SECRET);
    expect(result).toBe("[REDACTED] middle [REDACTED]");
  });
});
