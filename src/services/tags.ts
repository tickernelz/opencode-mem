import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { CONFIG } from "../config.js";
import { sep, normalize } from "node:path";

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
  const projectName = getProjectName(directory);
  const gitRepoUrl = getGitRepoUrl(directory);

  return {
    tag: `${CONFIG.containerTagPrefix}_project_${sha256(directory)}`,
    displayName: directory,
    projectPath: directory,
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
