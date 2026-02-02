import { CONFIG } from "../config.js";
import { getUserProfileContext } from "./user-profile/profile-context.js";

interface MemoryResultMinimal {
  similarity: number;
  memory?: string;
  chunk?: string;
}

interface MemoriesResponseMinimal {
  results?: MemoryResultMinimal[];
}

export async function formatContextForPrompt(
  userId: string | null,
  projectMemories: MemoriesResponseMinimal
): Promise<string> {
  const parts: string[] = ["[MEMORY]"];

  if (CONFIG.injectProfile && userId) {
    const profileContext = await getUserProfileContext(userId);
    if (profileContext) {
      parts.push("\n" + profileContext);
    }
  }

  const projectResults = projectMemories.results || [];
  if (projectResults.length > 0) {
    parts.push("\nProject Knowledge:");
    projectResults.forEach((mem) => {
      const similarity = Math.round(mem.similarity * 100);
      const content = mem.memory || mem.chunk || "";
      parts.push(`- [${similarity}%] ${content}`);
    });
  }

  if (parts.length === 1) {
    return "";
  }

  return parts.join("\n");
}
