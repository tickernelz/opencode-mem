import { describe, expect, it } from "bun:test";
import {
  isIdxDeleteMismatchError,
  isVacuumUnsupportedError,
} from "../src/services/turso/error-classifiers.js";

describe("isVacuumUnsupportedError", () => {
  it("matches Turso experimental VACUUM parse errors", () => {
    expect(
      isVacuumUnsupportedError(
        new Error(
          "SqliteError: prepare failed: Parse error: VACUUM is an experimental feature. Enable with --experimental-vacuum flag"
        )
      )
    ).toBe(true);
    expect(isVacuumUnsupportedError("experimental-vacuum flag required")).toBe(true);
  });

  it("ignores busy / lock errors", () => {
    expect(isVacuumUnsupportedError(new Error("database is locked"))).toBe(false);
    expect(isVacuumUnsupportedError("SQLITE_BUSY")).toBe(false);
  });
});

describe("isIdxDeleteMismatchError", () => {
  it("matches IdxDelete missing index entry", () => {
    expect(
      isIdxDeleteMismatchError(
        new Error(
          "Corrupt database: IdxDelete: no matching index entry found for key [Value(Numeric(Integer(1))), Value(Numeric(Integer(2135)))] while seeking"
        )
      )
    ).toBe(true);
    expect(isIdxDeleteMismatchError("no matching index entry found for key [1, 2]")).toBe(true);
  });

  it("does not treat every Corrupt database error as mismatch", () => {
    expect(isIdxDeleteMismatchError(new Error("Corrupt database: page checksum mismatch"))).toBe(
      false
    );
  });
});
