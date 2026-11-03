import { describe, expect, it } from "bun:test";
import {
  sanitizeMemoryContent,
  sanitizeMemoryField,
  stripPrivateContent,
} from "../src/services/privacy.js";

// Generated examples only. These are not working credentials.
const secrets = [
  `ghp_${"a1".repeat(18)}`,
  `gho_${"b2".repeat(18)}`,
  `ghr_${"c3".repeat(128)}`,
  `ghs_123456_eyJ${"a1".repeat(15)}.${"b2".repeat(150)}.${"c3".repeat(30)}`,
  `github_pat_${"c3".repeat(41)}`,
  `sk-proj-${"d4".repeat(30)}`,
  `sk-ant-api03-${"e5".repeat(30)}`,
  `sk-or-v1-${"a6".repeat(32)}`,
  `sk-${"f7".repeat(24)}`,
  `AIza${"g8".repeat(17)}x`,
  `xoxb-1234567890-${"h9".repeat(12)}`,
  `AKIA${"A1".repeat(8)}`,
  `ASIA${"B2".repeat(8)}`,
];

describe("credential redaction", () => {
  it("demonstrates credentials escaped the existing private-tag-only policy", () => {
    for (const secret of secrets) expect(stripPrivateContent(secret)).toBe(secret);
  });

  it("redacts recognizable credentials while retaining surrounding diagnostics", () => {
    for (const secret of secrets) {
      const clean = sanitizeMemoryContent(`Use ${secret} for auth; fixed retry.ts.`);
      expect(clean).not.toContain(secret);
      expect(clean).toMatch(/^Use \[REDACTED:[\w-]+\] for auth; fixed retry.ts\.$/);
      expect(sanitizeMemoryContent(clean)).toBe(clean);
    }
  });

  it("retains key names, quotes and auth schemes", () => {
    for (const assignment of [
      'API_KEY="abc123456789"',
      '"apiKey": "abc123456789"',
      "client_secret='abc123456789'",
      "AWS_SECRET_KEY=abc123456789",
      "export AWS_SECRET_KEY=abc123456789",
      'access_token: "abc123456789"',
      "PASSWORD=abc123456789",
    ]) {
      const clean = sanitizeMemoryContent(assignment);
      expect(clean).not.toContain("abc123456789");
      expect(clean).toContain("[REDACTED:credential]");
      expect(sanitizeMemoryContent(clean)).toBe(clean);
    }
    expect(sanitizeMemoryContent("Authorization: Bearer abc123456789.xyz")).toBe(
      "Authorization: Bearer [REDACTED:bearer-token]"
    );
  });

  it("redacts complete and incomplete private-key blocks without swallowing later context", () => {
    for (const type of [
      "PRIVATE KEY",
      "RSA PRIVATE KEY",
      "EC PRIVATE KEY",
      "OPENSSH PRIVATE KEY",
      "ENCRYPTED PRIVATE KEY",
    ]) {
      const key = `-----BEGIN ${type}-----\nYWJjMTIz\n-----END ${type}-----`;
      expect(sanitizeMemoryContent(`before\n${key}\nafter`)).toBe(
        "before\n[REDACTED:private-key]\nafter"
      );
      expect(sanitizeMemoryContent(`before\n-----BEGIN ${type}\nYWJjMTIz`)).toBe(
        "before\n[REDACTED:private-key]"
      );
    }
  });

  it("preserves fail-closed private tags and is idempotent across mixed content", () => {
    for (const input of [
      "before <private>outer <private>inner</private> still private</private> after",
      "before <private>unclosed",
      `${secrets.join("\n")}\n<private>hidden</private>\nAPI_KEY=abc123456789`,
    ]) {
      const once = sanitizeMemoryContent(input);
      expect(once).not.toContain("hidden");
      expect(once).not.toContain("unclosed");
      expect(once).not.toContain("still private");
      expect(sanitizeMemoryContent(once)).toBe(once);
    }
  });

  it("preserves near misses, hashes, application identifiers and source expressions", () => {
    const corpus = [
      "SHA256=" + "a1".repeat(32),
      "commit " + "b2".repeat(20),
      "id=550e8400-e29b-41d4-a716-446655440000",
      "blob=" + "YWJjMTIz".repeat(16),
      "API_KEY=process.env.API_KEY",
      "apiKey: config.apiKey",
      "API_KEY=${API_KEY}",
      'apiKey: "YOUR_API_KEY_HERE"',
      "password=replace-me",
      "const apiKey = credentialValue1;",
      "const apiKey = credentialValue1234;",
      "const API_KEY = credentialValue1234;",
      "apiKey: credentialValue1234",
      "Bearer YOUR_TOKEN_HERE",
      "Bearer REPLACE_WITH_TOKEN",
      "Use bearer authentication rather than cookies.",
      'API_KEY="EXAMPLE_API_KEY_1234"',
      "accessTokenCount=1234567890",
      "ghp_short_example",
      "xoxb-this-is-a-placeholder-not-a-token",
      "github_pat_documentation",
      "prefixghp_" + "a1".repeat(18),
      "AKIA123456789012345", // too short
      "-----BEGIN PUBLIC KEY-----\nYWJjMTIz\n-----END PUBLIC KEY-----",
      "Bearer token",
    ];
    for (const text of corpus) expect(sanitizeMemoryContent(text)).toBe(text);
  });

  it("documents deliberate limits instead of promising universal secret detection", () => {
    for (const text of [
      "password=correcthorsebatterystaple",
      "api_key=opaqueCustomValue",
      "access_token: abc123456789",
      "an arbitrary secret with no identifying context",
    ]) {
      expect(sanitizeMemoryContent(text)).toBe(text);
      expect(sanitizeMemoryContent(`<private>${text}</private>`)).toBe("[REDACTED]");
    }
  });

  it("sanitizes structured values before JSON escaping and preserves credential field context", () => {
    const input = {
      password: "abc123456789",
      command: 'API_KEY="abc123456789" node task.js',
      nested: { apiKey: "abc123456789", count: 123, enabled: true },
      other: "credentialValue1234",
      hash: "a1".repeat(32),
    };
    const result = JSON.parse(JSON.stringify(input, sanitizeMemoryField));
    expect(result.password).toBe("[REDACTED:credential]");
    expect(result.nested.apiKey).toBe("[REDACTED:credential]");
    expect(result.command).toBe('API_KEY="[REDACTED:credential]" node task.js');
    expect(result.nested.count).toBe(123);
    expect(result.nested.enabled).toBe(true);
    expect(result.other).toBe(input.other);
    expect(result.hash).toBe(input.hash);
    expect(JSON.stringify(result, sanitizeMemoryField)).toBe(JSON.stringify(result));
    expect(sanitizeMemoryField("password", "YOUR_PASSWORD_HERE")).toBe("YOUR_PASSWORD_HERE");
    expect(sanitizeMemoryField("password", "process.env.PASSWORD")).toBe("process.env.PASSWORD");
    expect(sanitizeMemoryField("password", null)).toBe(null);
    expect(sanitizeMemoryField("apiKey", "EXAMPLE_API_KEY_1234")).toBe("EXAMPLE_API_KEY_1234");
  });

  it("processes bounded capture-sized inputs without pathological growth", () => {
    const text = (secrets[0] + " ordinary context / = + abc123 ".repeat(2400)).slice(0, 65536);
    const start = performance.now();
    for (let i = 0; i < 25; i++) {
      const clean = sanitizeMemoryContent(text);
      expect(clean.length).toBeLessThanOrEqual(text.length);
      expect(clean).not.toContain(secrets[0]!);
      expect(clean).toContain("[REDACTED:github-token]");
    }
    // Generous regression guard, not a hardware-specific benchmark.
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
