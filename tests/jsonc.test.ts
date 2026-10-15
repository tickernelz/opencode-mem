import { describe, expect, it } from "bun:test";
import { stripJsoncComments } from "../src/services/jsonc.js";

describe("JSONC string preservation", () => {
  for (const value of [",}", ",]", ", }", ", ]", 'say "a, }b"', "\\path,]end"]) {
    it(`preserves ${JSON.stringify(value)} inside string values and keys`, () => {
      const expected = { [value]: value };
      expect(JSON.parse(stripJsoncComments(JSON.stringify(expected)))).toEqual(expected);
    });
  }

  it("handles escaped backslashes before a closing quote", () => {
    const expected = { path: "C:\\cache\\", next: "value" };
    expect(JSON.parse(stripJsoncComments(JSON.stringify(expected)))).toEqual(expected);
  });

  it("keeps comment-like text inside strings", () => {
    const expected = { url: "https://example.invalid/a//b", text: "/* keep, } */" };
    expect(JSON.parse(stripJsoncComments(JSON.stringify(expected)))).toEqual(expected);
  });

  it("removes structural trailing commas separated by comments and whitespace", () => {
    const input = `{
      // A line comment
      "stop": [",}", ",]", /* before array end */ ],
      "nested": {"enabled": true, // before object end
      },
    }`;
    expect(JSON.parse(stripJsoncComments(input))).toEqual({
      stop: [",}", ",]"],
      nested: { enabled: true },
    });
  });

  it("keeps ordinary separators between array and object entries", () => {
    const expected = { first: [1, 2, 3], second: { a: true, b: false } };
    expect(JSON.parse(stripJsoncComments(JSON.stringify(expected)))).toEqual(expected);
  });
});
