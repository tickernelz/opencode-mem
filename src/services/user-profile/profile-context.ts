import { userProfileManager } from "./user-profile-manager.js";
import type { UserProfileData } from "./types.js";

export async function getUserProfileContext(userId: string): Promise<string | null> {
  const profile = await userProfileManager.getActiveProfile(userId);

  if (!profile) {
    return null;
  }

  const profileData: UserProfileData = JSON.parse(profile.profileData);
  const parts: string[] = [];

  if (profileData.preferences.length > 0) {
    parts.push("User Preferences:");
    profileData.preferences
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5)
      .forEach((pref) => {
        parts.push(`- [${pref.category}] ${pref.description}`);
      });
  }

  if (profileData.patterns.length > 0) {
    parts.push("\nUser Patterns:");
    profileData.patterns
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 5)
      .forEach((pattern) => {
        parts.push(`- [${pattern.category}] ${pattern.description}`);
      });
  }

  if (profileData.workflows.length > 0) {
    parts.push("\nUser Workflows:");
    profileData.workflows
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 3)
      .forEach((workflow) => {
        parts.push(`- ${workflow.description}`);
      });
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join("\n");
}
