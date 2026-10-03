import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  if (path === "~") {
    return homedir();
  }
  return path;
}

// Any group or other bit set means someone besides the owner can reach the
// secret. Owner bits are deliberately excluded: 0600 and 0400 are both fine.
const GROUP_AND_OTHER_BITS = 0o077;

function checkFilePermissions(filePath: string): void {
  if (platform() === "win32") {
    return;
  }

  try {
    const stats = statSync(filePath);
    const mode = stats.mode & 0o777;

    // Test the bits, not the numeric value. `mode > 0o600` compared a bitmask as
    // an integer, so it missed every mode that grants group/other access while
    // sorting numerically lower -- 0404 (world-readable) and 0006
    // (world-writable) passed silently, while 0640, strictly less permissive
    // than 0644, warned. The comparison and the property being checked were
    // simply unrelated.
    const exposedBits = mode & GROUP_AND_OTHER_BITS;

    if (exposedBits !== 0) {
      console.warn(
        `Warning: Secret file ${filePath} has permissive permissions (${mode.toString(8).padStart(3, "0")}) granting group/other access. Recommend chmod 600.`
      );
    }
  } catch {
    console.warn(`Warning: Could not check file permissions for ${filePath}`);
  }
}

export function resolveSecretValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  if (value.startsWith("file://")) {
    const filePath = expandPath(value.slice(7));

    if (!existsSync(filePath)) {
      throw new Error(`Secret file not found: ${filePath}`);
    }

    try {
      checkFilePermissions(filePath);

      const content = readFileSync(filePath, "utf-8");
      return content.trim();
    } catch (error) {
      throw new Error(`Failed to read secret file ${filePath}: ${error}`, { cause: error });
    }
  }

  if (value.startsWith("env://")) {
    const envVar = value.slice(6);
    const envValue = process.env[envVar];

    if (!envValue) {
      throw new Error(`Environment variable not found: ${envVar}`);
    }

    return envValue;
  }

  return value;
}
