import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { log } from "../../logger.js";

export interface CopilotAuth {
  token: string;
  enterpriseUrl?: string;
}

interface OpenCodeOAuthEntry {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  accountId?: string;
  enterpriseUrl?: string;
}

function getOpenCodeDataDir(): string {
  const os = platform();

  switch (os) {
    case "win32":
      return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
    default:
      return join(homedir(), ".local", "share", "opencode");
  }
}

export async function getCopilotAuth(): Promise<CopilotAuth | null> {
  const dataDir = getOpenCodeDataDir();
  const authPath = join(dataDir, "auth.json");

  if (!existsSync(authPath)) {
    log("GitHub Copilot auth not found - opencode auth.json does not exist", {
      path: authPath,
    });
    return null;
  }

  try {
    const content = readFileSync(authPath, "utf-8");
    const authData = JSON.parse(content) as Record<string, unknown>;

    const providers = ["github-copilot", "github-copilot-enterprise"];

    for (const provider of providers) {
      const entry = authData[provider];

      if (!entry || typeof entry !== "object") {
        continue;
      }

      const oauthEntry = entry as Record<string, unknown>;

      if (oauthEntry.type !== "oauth") {
        continue;
      }

      const token = (oauthEntry.refresh as string) || (oauthEntry.access as string);

      if (!token) {
        log("GitHub Copilot auth entry found but no token present", {
          provider,
          hasRefresh: !!oauthEntry.refresh,
          hasAccess: !!oauthEntry.access,
        });
        continue;
      }

      const result: CopilotAuth = { token };

      if (oauthEntry.enterpriseUrl && typeof oauthEntry.enterpriseUrl === "string") {
        result.enterpriseUrl = oauthEntry.enterpriseUrl;
      }

      log("GitHub Copilot auth retrieved successfully", {
        provider,
        hasEnterpriseUrl: !!result.enterpriseUrl,
      });

      return result;
    }

    log("No GitHub Copilot OAuth entry found in auth.json", {
      availableProviders: Object.keys(authData),
    });
    return null;
  } catch (error) {
    log("Failed to read GitHub Copilot auth from opencode", {
      error: String(error),
      path: authPath,
    });
    return null;
  }
}

export function getCopilotApiUrl(enterpriseUrl?: string): string {
  if (enterpriseUrl) {
    const domain = enterpriseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return `https://copilot-api.${domain}`;
  }
  return "https://api.githubcopilot.com";
}

export async function hasCopilotAuth(): Promise<boolean> {
  const auth = await getCopilotAuth();
  return auth !== null;
}
