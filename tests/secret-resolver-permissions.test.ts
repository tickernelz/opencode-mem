import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolveSecretValue } from "../src/infra/secret-resolver.js";

/**
 * `checkFilePermissions` warns when a `file://` secret is readable by anyone
 * besides its owner. It used to test `mode > 0o600`, comparing a bitmask as an
 * integer -- so it missed every mode that grants group/other access while
 * sorting numerically lower, and warned on modes that were strictly safer than
 * ones it let through.
 */
describe("secret file permission warnings", () => {
  const SECRET = "sk-super-secret-value";
  let spies: ReturnType<typeof spyOn>[] = [];
  let warnings: string[] = [];

  function arrange(mode: number, platformName = "linux") {
    warnings = [];
    spies = [
      spyOn(os, "platform").mockReturnValue(platformName as ReturnType<typeof os.platform>),
      spyOn(fs, "existsSync").mockReturnValue(true),
      spyOn(fs, "readFileSync").mockReturnValue(`${SECRET}\n` as never),
      // Only the permission bits are consulted; the file-type bits above 0o777
      // are included so the mask in the source is what strips them.
      spyOn(fs, "statSync").mockReturnValue({ mode: 0o100000 | mode } as never),
      spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      }),
    ];
  }

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies = [];
  });

  const warned = () => warnings.some((line) => line.includes("permissive permissions"));

  // Owner-only modes: no exposure, so no warning.
  const SAFE_MODES = [0o600, 0o400, 0o200, 0o700, 0o000];

  // Every one of these grants read, write or execute to group or other.
  const EXPOSED_MODES = [
    0o644, // rw-r--r--  world-readable
    0o640, // rw-r-----  group-readable
    0o604, // rw----r--  world-readable
    0o606, // rw----rw-  world-writable
    0o404, // r-----r--  world-readable, and NUMERICALLY BELOW 0o600
    0o060, // ---rw----  group-writable, numerically below 0o600
    0o006, // ------rw-  world-writable, numerically below 0o600
    0o007, // ------rwx  world-executable, numerically below 0o600
    0o077, // ---rwxrwx  group+other everything, numerically below 0o600
    0o777, // rwxrwxrwx
  ];

  it.each(SAFE_MODES)("does not warn for owner-only mode %s", (mode) => {
    arrange(mode);
    expect(resolveSecretValue("file:///tmp/secret")).toBe(SECRET);
    expect(warned()).toBe(false);
  });

  it.each(EXPOSED_MODES)("warns for group/other-accessible mode %s", (mode) => {
    arrange(mode);
    expect(resolveSecretValue("file:///tmp/secret")).toBe(SECRET);
    expect(warned()).toBe(true);
  });

  it("warns for a world-readable file that sorts below the old threshold", () => {
    // The headline case. 0o404 is world-readable, yet `0o404 > 0o600` is false, so
    // it passed silently -- while 0o640, which exposes strictly less, warned.
    arrange(0o404);
    resolveSecretValue("file:///tmp/secret");
    const exposed = warned();

    arrange(0o640);
    resolveSecretValue("file:///tmp/secret");
    const lessExposed = warned();

    expect(exposed).toBe(true);
    expect(lessExposed).toBe(true);
  });

  it("reports the mode in octal, zero-padded", () => {
    // A mode like 0o006 must not render as "6"; the message is the only signal
    // the user gets, so it has to name the mode it is complaining about.
    arrange(0o006);
    resolveSecretValue("file:///tmp/secret");
    expect(warnings.join("\n")).toContain("(006)");
  });

  it("still skips the check entirely on win32", () => {
    // POSIX mode bits are not meaningful there, and the early return is
    // deliberate -- unchanged by this fix.
    arrange(0o777, "win32");
    expect(resolveSecretValue("file:///tmp/secret")).toBe(SECRET);
    expect(warned()).toBe(false);
  });

  it("returns the secret regardless of the warning", () => {
    // The check advises; it must never block a resolution that would otherwise
    // succeed, or a permission nit would take the plugin down.
    arrange(0o777);
    expect(resolveSecretValue("file:///tmp/secret")).toBe(SECRET);
    expect(warned()).toBe(true);
  });
});
