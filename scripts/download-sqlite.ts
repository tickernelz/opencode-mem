import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GITHUB_REPO = "tickernelz/opencode-mem";

function getNativeDir(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, "..", "native");
}

function downloadDylib(arch: string): boolean {
  const nativeDir = getNativeDir();
  const targetDir = join(nativeDir, `darwin-${arch}`);
  const targetFile = join(targetDir, "libsqlite3.dylib");

  if (existsSync(targetFile)) {
    console.log(`[opencode-mem] SQLite dylib already exists: ${targetFile}`);
    return true;
  }

  mkdirSync(targetDir, { recursive: true });

  const downloadUrl = `https://github.com/${GITHUB_REPO}/releases/latest/download/libsqlite3-darwin-${arch}.dylib`;

  console.log(`[opencode-mem] Downloading SQLite dylib for darwin-${arch}...`);

  try {
    execSync(`curl -fsSL "${downloadUrl}" -o "${targetFile}"`, {
      timeout: 60000,
      stdio: "pipe",
    });

    if (existsSync(targetFile)) {
      console.log(`[opencode-mem] Downloaded SQLite dylib: ${targetFile}`);
      return true;
    }
  } catch (error) {
    console.log(`[opencode-mem] Failed to download SQLite dylib: ${error}`);
  }

  console.log(`[opencode-mem] Will fallback to Homebrew SQLite if available.`);
  return false;
}

function main(): void {
  if (process.platform !== "darwin") {
    console.log("[opencode-mem] Skipping SQLite dylib download (not macOS)");
    return;
  }

  const arch = process.arch;
  if (arch !== "arm64" && arch !== "x64") {
    console.log(`[opencode-mem] Unsupported architecture: ${arch}`);
    return;
  }

  downloadDylib(arch);
}

main();
