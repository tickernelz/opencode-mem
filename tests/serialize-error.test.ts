import { describe, expect, it } from "bun:test";
import { serializeError } from "../src/services/logger.js";

describe("serializeError", () => {
  it("includes message, name, and stack for Error instances", () => {
    const err = new Error("timed out");
    const serialized = serializeError(err);
    expect(serialized.error).toBe("timed out");
    expect(serialized.name).toBe("Error");
    expect(serialized.stack).toContain("timed out");
  });

  it("includes cause message when present", () => {
    const cause = new Error("db busy");
    const err = new Error("Memory persistence failed", { cause });
    const serialized = serializeError(err);
    expect(serialized.cause).toBe("db busy");
  });

  it("stringifies non-Error values", () => {
    expect(serializeError("plain")).toEqual({ error: "plain" });
  });
  it("uses a named error when its message is empty or whitespace", () => {
    for (const message of ["", "  "]) {
      const error = Object.assign(new Error(message), { name: "Session.NotFoundError" });
      expect(serializeError(error).error).toBe("Session.NotFoundError");
      expect(serializeError(error).stack).toBe(error.stack);
    }
  });

  it("prefers a specific tag over the generic Error name", () => {
    expect(
      serializeError(
        Object.assign(new Error(""), {
          _tag: "Session.NotFoundError",
        })
      ).error
    ).toBe("Session.NotFoundError");
  });

  it("keeps anonymous empty errors actionable", () => {
    expect(serializeError(Object.assign(new Error(""), { name: "" })).error).toBe("Error");
  });

  it("uses names or tags for structured errors without dumping their payload", () => {
    expect(serializeError({ _tag: "Session.NotFoundError", sessionID: "private-session" })).toEqual(
      { error: "Session.NotFoundError" }
    );
    expect(
      serializeError({ name: "Session.NotFoundError", message: " ", secret: "not-for-logs" })
    ).toEqual({ error: "Session.NotFoundError" });
  });

  it("provides useful text for empty or structured causes", () => {
    const cause = Object.assign(new Error(""), { name: "Session.NotFoundError" });
    expect(serializeError(new Error("Context failed", { cause })).cause).toBe(
      "Session.NotFoundError"
    );
    expect(
      serializeError(new Error("Context failed", { cause: { _tag: "Session.NotFoundError" } }))
        .cause
    ).toBe("Session.NotFoundError");
  });
});
