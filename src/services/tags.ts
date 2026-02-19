import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { CONFIG } from "../config.js";
import { sep, normalize, resolve, isAbsolute } from "node:path";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export interface TagInfo {
  tag: string;
  displayName: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
}

export function getGitEmail(): string | null {
  try {
    const email = execSync("git config user.email", { encoding: "utf-8" }).trim();
    return email || null;
  } catch {
    return null;
  }
}

export function getGitName(): string | null {
  try {
    const name = execSync("git config user.name", { encoding: "utf-8" }).trim();
    return name || null;
  } catch {
    return null;
  }
}

export function getGitRepoUrl(directory: string): string | null {
  try {
    const url = execSync("git config --get remote.origin.url", {
      encoding: "utf-8",
      cwd: directory,
    }).trim();
    return url || null;
  } catch {
    return null;
  }
}

export function getGitCommonDir(directory: string): string | null {
  try {
    const commonDir = execSync("git rev-parse --git-common-dir", {
      encoding: "utf-8",
      cwd: directory,
    }).trim();

    if (!commonDir) {
      return null;
    }

    return isAbsolute(commonDir) ? normalize(commonDir) : normalize(resolve(directory, commonDir));
  } catch {
    return null;
  }
}

export function getGitTopLevel(directory: string): string | null {
  try {
    const topLevel = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      cwd: directory,
    }).trim();
    return topLevel || null;
  } catch {
    return null;
  }
}

export function getProjectIdentity(directory: string): string {
  const commonDir = getGitCommonDir(directory);
  if (commonDir) {
    return `git-common:${commonDir}`;
  }

  const gitRepoUrl = getGitRepoUrl(directory);
  if (gitRepoUrl) {
    return `remote:${gitRepoUrl}`;
  }

  return `path:${normalize(directory)}`;
}

export function getProjectName(directory: string): string {
  // Normalize path to handle both Unix and Windows separators
  const normalized = normalize(directory);
  const parts = normalized.split(sep).filter((p) => p);
  return parts[parts.length - 1] || directory;
}

export function getUserTagInfo(): TagInfo {
  const email = CONFIG.userEmailOverride || getGitEmail();
  const name = CONFIG.userNameOverride || getGitName();

  if (email) {
    return {
      tag: `${CONFIG.containerTagPrefix}_user_${sha256(email)}`,
      displayName: name || email,
      userName: name || undefined,
      userEmail: email,
    };
  }

  const fallback = name || process.env.USER || process.env.USERNAME || "anonymous";
  return {
    tag: `${CONFIG.containerTagPrefix}_user_${sha256(fallback)}`,
    displayName: fallback,
    userName: fallback,
    userEmail: undefined,
  };
}

export function getProjectTagInfo(directory: string): TagInfo {
  const topLevel = getGitTopLevel(directory) || directory;
  const projectName = getProjectName(topLevel);
  const gitRepoUrl = getGitRepoUrl(directory);
  const projectIdentity = getProjectIdentity(directory);

  return {
    tag: `${CONFIG.containerTagPrefix}_project_${sha256(projectIdentity)}`,
    displayName: topLevel,
    projectPath: topLevel,
    projectName,
    gitRepoUrl: gitRepoUrl || undefined,
  };
}

export function getTags(directory: string): {
  user: TagInfo;
  project: TagInfo;
} {
  return {
    user: getUserTagInfo(),
    project: getProjectTagInfo(directory),
  };
}
