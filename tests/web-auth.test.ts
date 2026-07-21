import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { userInfo } from "node:os";
import { WEB_AUTH_REALM, WebAuth } from "../src/services/web-auth.js";

function basicHeader(user: string, pass: string): string {
  const encoded = Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

describe("WebAuth", () => {
  beforeEach(() => {});

  afterEach(() => {});

  describe("configuration", () => {
    it("is disabled when password is empty", () => {
      const auth = new WebAuth({ password: "" });
      expect(auth.isEnabled()).toBe(false);
    });

    it("is disabled when password is whitespace only", () => {
      const auth = new WebAuth({ password: "   " });
      expect(auth.isEnabled()).toBe(false);
    });

    it("is disabled when password is omitted", () => {
      const auth = new WebAuth();
      expect(auth.isEnabled()).toBe(false);
    });

    it("is enabled when password is set", () => {
      const auth = new WebAuth({ password: "secret" });
      expect(auth.isEnabled()).toBe(true);
    });

    it("defaults username to os.userInfo().username when not provided", () => {
      const expected = userInfo().username;
      const auth = new WebAuth({ password: "secret" });
      expect(auth.getConfig().username).toBe(expected);
    });

    it("uses explicit username when provided", () => {
      const auth = new WebAuth({ password: "secret", username: "custom-admin" });
      expect(auth.getConfig().username).toBe("custom-admin");
    });

    it("treats whitespace-only username as missing and falls back to OS user", () => {
      const expected = userInfo().username;
      const auth = new WebAuth({ password: "secret", username: "  " });
      expect(auth.getConfig().username).toBe(expected);
    });
  });

  describe("check (HTTP Basic Auth)", () => {
    it("passes through when auth is disabled", () => {
      const auth = new WebAuth();
      const result = auth.check(new Request("http://x/api/memories"), "/api/memories");
      expect(result.ok).toBe(true);
    });

    it("always allows the health endpoint through", () => {
      const auth = new WebAuth({ password: "secret" });
      const result = auth.check(new Request("http://x/api/health"), "/api/health");
      expect(result.ok).toBe(true);
    });

    it("rejects requests without an Authorization header", () => {
      const auth = new WebAuth({ password: "secret", username: "admin" });
      const result = auth.check(new Request("http://x/api/memories"), "/api/memories");
      expect(result.ok).toBe(false);
      expect(result.response?.status).toBe(401);
      expect(result.response?.headers.get("WWW-Authenticate")).toContain(
        `Basic realm="${WEB_AUTH_REALM}"`
      );
    });

    it("rejects requests with the wrong credentials", () => {
      const auth = new WebAuth({ password: "right", username: "admin" });
      const req = new Request("http://x/api/memories", {
        headers: { Authorization: basicHeader("admin", "wrong") },
      });
      const result = auth.check(req, "/api/memories");
      expect(result.ok).toBe(false);
      expect(result.response?.status).toBe(401);
    });

    it("rejects requests with a non-Basic Authorization scheme", () => {
      const auth = new WebAuth({ password: "secret" });
      const req = new Request("http://x/api/memories", {
        headers: { Authorization: "Bearer not-a-basic-token" },
      });
      const result = auth.check(req, "/api/memories");
      expect(result.ok).toBe(false);
    });

    it("rejects requests with malformed Basic payload (no colon)", () => {
      const auth = new WebAuth({ password: "secret" });
      const encoded = Buffer.from("no-colon-here", "utf8").toString("base64");
      const req = new Request("http://x/api/memories", {
        headers: { Authorization: `Basic ${encoded}` },
      });
      const result = auth.check(req, "/api/memories");
      expect(result.ok).toBe(false);
    });

    it("accepts requests with the correct credentials", () => {
      const auth = new WebAuth({ password: "secret", username: "admin" });
      const req = new Request("http://x/api/memories", {
        headers: { Authorization: basicHeader("admin", "secret") },
      });
      const result = auth.check(req, "/api/memories");
      expect(result.ok).toBe(true);
    });

    it("treats username case-sensitively", () => {
      const auth = new WebAuth({ password: "secret", username: "Admin" });
      const wrongCase = new Request("http://x/api/memories", {
        headers: { Authorization: basicHeader("admin", "secret") },
      });
      expect(auth.check(wrongCase, "/api/memories").ok).toBe(false);

      const rightCase = new Request("http://x/api/memories", {
        headers: { Authorization: basicHeader("Admin", "secret") },
      });
      expect(auth.check(rightCase, "/api/memories").ok).toBe(true);
    });

    it("accepts credentials whose password contains a colon", () => {
      const auth = new WebAuth({ password: "pa:ss:word", username: "admin" });
      const req = new Request("http://x/api/memories", {
        headers: { Authorization: basicHeader("admin", "pa:ss:word") },
      });
      expect(auth.check(req, "/api/memories").ok).toBe(true);
    });
  });

  describe("challenge response", () => {
    it("uses the configured realm in WWW-Authenticate", () => {
      const auth = new WebAuth({ password: "secret" });
      const response = auth.challenge();
      expect(response.status).toBe(401);
      const header = response.headers.get("WWW-Authenticate") ?? "";
      expect(header.startsWith("Basic")).toBe(true);
      expect(header).toContain(`realm="${WEB_AUTH_REALM}"`);
      expect(header).toContain('charset="UTF-8"');
    });

    it("marks the challenge as no-store so browsers do not cache it", () => {
      const auth = new WebAuth({ password: "secret" });
      const response = auth.challenge();
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    });
  });
});
