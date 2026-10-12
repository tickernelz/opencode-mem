import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { Plugin } from "vite";

type MemoryItem = {
  id: string;
  type: "memory" | "prompt";
  content: string;
  tags?: string[];
  displayName?: string;
  projectName?: string;
  isPinned?: boolean;
  createdAt?: string;
  updatedAt?: string;
  linkedMemoryId?: string;
  linkedPromptId?: string;
  memoryType?: string;
  [key: string]: unknown;
};

type MemoriesFile = { items: MemoryItem[] };

type SkillItem = {
  id: string;
  name: string;
  description: string;
  content: string;
  autoinvoke: boolean;
  enabled: boolean;
  containerTag: string | null;
  createdAt: string;
  updatedAt: string;
};

type SkillsFile = { items: SkillItem[] };

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function stubOk(message = "Simulated success") {
  return { success: true, data: { message } };
}

function memoryTime(value: unknown): number {
  if (typeof value === "string" || typeof value === "number") {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
  }
  return 0;
}

function sortMemories(items: MemoryItem[]) {
  return [...items].sort((a, b) => {
    const pinA = a.type === "memory" && a.isPinned ? 1 : 0;
    const pinB = b.type === "memory" && b.isPinned ? 1 : 0;
    if (pinA !== pinB) return pinB - pinA;
    return memoryTime(b.createdAt) - memoryTime(a.createdAt);
  });
}

function paginate(items: MemoryItem[], page: number, pageSize: number) {
  const sorted = sortMemories(items);
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = (safePage - 1) * pageSize;
  return {
    items: sorted.slice(start, start + pageSize),
    total,
    page: safePage,
    pageSize,
    totalPages,
  };
}

function filterItems(items: MemoryItem[], opts: { tags?: string[]; q?: string }) {
  let next = items;
  if (opts.tags?.length) {
    const needles = opts.tags.map((tag) => tag.toLowerCase());
    next = next.filter((item) =>
      needles.some(
        (tag) =>
          item.displayName?.toLowerCase() === tag ||
          item.projectName?.toLowerCase() === tag ||
          item.tags?.some((t) => t.toLowerCase() === tag)
      )
    );
  }
  if (opts.q) {
    const needle = opts.q.toLowerCase();
    next = next.filter(
      (item) =>
        item.content.toLowerCase().includes(needle) ||
        item.tags?.some((t) => t.toLowerCase().includes(needle)) ||
        item.displayName?.toLowerCase().includes(needle)
    );
  }
  return next;
}

/** Serves `/api/*` from `web/sim` fixtures when OPENCODE_MEM_SIM=1. */
export function opencodeMemSimPlugin(simRoot: string): Plugin {
  return {
    name: "opencode-mem-sim",
    configureServer(server) {
      // Mutable session copy so pin/edit/delete survive reloads during the Vite process.
      let memories: MemoryItem[] = readJson<MemoriesFile>(
        path.join(simRoot, "memories.json")
      ).items.map((item) => ({ ...item }));
      let skills: SkillItem[] = readJson<SkillsFile>(path.join(simRoot, "skills.json")).items.map(
        (item) => ({ ...item })
      );

      function findMemory(id: string) {
        return memories.find((item) => item.id === id);
      }

      function findSkill(id: string) {
        return skills.find((item) => item.id === id);
      }

      function memoryCount() {
        return memories.filter((item) => item.type === "memory").length;
      }

      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url || "/";
        if (!rawUrl.startsWith("/api")) {
          next();
          return;
        }

        const url = new URL(rawUrl, "http://localhost");
        const pathname = url.pathname;
        const method = (req.method || "GET").toUpperCase();

        try {
          if (pathname === "/api/health" && method === "GET") {
            sendJson(res, 200, readJson(path.join(simRoot, "health.json")));
            return;
          }

          if (pathname === "/api/tags" && method === "GET") {
            sendJson(res, 200, readJson(path.join(simRoot, "tags.json")));
            return;
          }

          if (pathname === "/api/stats" && method === "GET") {
            sendJson(res, 200, {
              success: true,
              data: { total: memoryCount() },
            });
            return;
          }

          if (pathname === "/api/migration/detect" && method === "GET") {
            sendJson(res, 200, readJson(path.join(simRoot, "migration-detect.json")));
            return;
          }

          if (pathname === "/api/migration/tags/detect" && method === "GET") {
            sendJson(res, 200, readJson(path.join(simRoot, "migration-tags-detect.json")));
            return;
          }

          if (pathname === "/api/user-profile" && method === "GET") {
            sendJson(res, 200, readJson(path.join(simRoot, "user-profile.json")));
            return;
          }

          if (pathname === "/api/user-profile/changelog" && method === "GET") {
            sendJson(res, 200, readJson(path.join(simRoot, "changelog.json")));
            return;
          }

          if ((pathname === "/api/memories" || pathname === "/api/search") && method === "GET") {
            const page = Number(url.searchParams.get("page") || "1");
            const pageSize = Number(url.searchParams.get("pageSize") || "20");
            const tags = url.searchParams.getAll("tag").filter(Boolean);
            const q =
              pathname === "/api/search" ? url.searchParams.get("q") || undefined : undefined;
            const filtered = filterItems(memories, { tags, q });
            sendJson(res, 200, { success: true, data: paginate(filtered, page, pageSize) });
            return;
          }

          const pinMatch = pathname.match(/^\/api\/memories\/([^/]+)\/(pin|unpin)$/);
          if (pinMatch && method === "POST") {
            const [, id, action] = pinMatch;
            const item = findMemory(decodeURIComponent(id));
            if (!item || item.type !== "memory") {
              sendJson(res, 404, { success: false, error: "Memory not found" });
              return;
            }
            item.isPinned = action === "pin";
            sendJson(res, 200, stubOk(action === "pin" ? "Pinned" : "Unpinned"));
            return;
          }

          const memoryIdMatch = pathname.match(/^\/api\/memories\/([^/]+)$/);
          if (memoryIdMatch && method === "PUT") {
            const id = decodeURIComponent(memoryIdMatch[1]);
            const item = findMemory(id);
            if (!item) {
              sendJson(res, 404, { success: false, error: "Memory not found" });
              return;
            }
            let body = "";
            req.on("data", (chunk) => {
              body += chunk;
            });
            req.on("end", () => {
              try {
                const parsed = body
                  ? (JSON.parse(body) as { content?: string; tags?: string[]; type?: string })
                  : {};
                if (typeof parsed.content === "string") {
                  item.content = parsed.content;
                }
                if (Array.isArray(parsed.tags)) {
                  item.tags = parsed.tags.map((tag) => String(tag).trim()).filter(Boolean);
                }
                if (typeof parsed.type === "string") {
                  item.memoryType = parsed.type || undefined;
                }
                item.updatedAt = new Date().toISOString();
                sendJson(res, 200, stubOk("Updated"));
              } catch (error) {
                sendJson(res, 400, {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            });
            return;
          }

          if (memoryIdMatch && method === "DELETE") {
            const id = decodeURIComponent(memoryIdMatch[1]);
            const before = memories.length;
            memories = memories.filter(
              (item) => item.id !== id && item.linkedMemoryId !== id && item.linkedPromptId !== id
            );
            if (memories.length === before) {
              sendJson(res, 404, { success: false, error: "Memory not found" });
              return;
            }
            sendJson(res, 200, stubOk("Deleted"));
            return;
          }

          const promptIdMatch = pathname.match(/^\/api\/prompts\/([^/]+)$/);
          if (promptIdMatch && method === "DELETE") {
            const id = decodeURIComponent(promptIdMatch[1]);
            const before = memories.length;
            memories = memories.filter(
              (item) => item.id !== id && item.linkedPromptId !== id && item.linkedMemoryId !== id
            );
            if (memories.length === before) {
              sendJson(res, 404, { success: false, error: "Prompt not found" });
              return;
            }
            sendJson(res, 200, stubOk("Deleted"));
            return;
          }

          if (pathname === "/api/user-profile/ai-cleanup" && method === "POST") {
            sendJson(res, 200, readJson(path.join(simRoot, "ai-cleanup.json")));
            return;
          }

          if (pathname === "/api/skills" && method === "GET") {
            const enabledOnly = url.searchParams.get("enabledOnly") === "true";
            const items = enabledOnly ? skills.filter((skill) => skill.enabled) : skills;
            sendJson(res, 200, { success: true, data: { items } });
            return;
          }

          if (pathname === "/api/skills" && method === "POST") {
            void readBody(req).then((raw) => {
              try {
                const parsed = raw ? (JSON.parse(raw) as Partial<SkillItem> & { id?: string }) : {};
                const id = String(parsed.id || "").trim();
                const name = String(parsed.name || "").trim();
                const content = String(parsed.content || "");
                if (!id || !name || !content.trim()) {
                  sendJson(res, 400, {
                    success: false,
                    error: "id, name, and content are required",
                  });
                  return;
                }
                if (findSkill(id)) {
                  sendJson(res, 400, { success: false, error: `Skill already exists: ${id}` });
                  return;
                }
                const now = new Date().toISOString();
                const skill: SkillItem = {
                  id,
                  name,
                  description: String(parsed.description || "").trim(),
                  content,
                  autoinvoke: parsed.autoinvoke !== false,
                  enabled: parsed.enabled !== false,
                  containerTag:
                    parsed.containerTag === undefined ? null : (parsed.containerTag ?? null),
                  createdAt: now,
                  updatedAt: now,
                };
                skills = [skill, ...skills];
                sendJson(res, 200, { success: true, data: skill });
              } catch (error) {
                sendJson(res, 400, {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            });
            return;
          }

          const skillIdMatch = pathname.match(/^\/api\/skills\/([^/]+)$/);
          if (skillIdMatch && method === "GET") {
            const skill = findSkill(decodeURIComponent(skillIdMatch[1]));
            if (!skill) {
              sendJson(res, 404, { success: false, error: "Skill not found" });
              return;
            }
            sendJson(res, 200, { success: true, data: skill });
            return;
          }

          if (skillIdMatch && method === "PUT") {
            const id = decodeURIComponent(skillIdMatch[1]);
            const skill = findSkill(id);
            if (!skill) {
              sendJson(res, 404, { success: false, error: "Skill not found" });
              return;
            }
            void readBody(req).then((raw) => {
              try {
                const parsed = raw ? (JSON.parse(raw) as Partial<SkillItem>) : {};
                if (typeof parsed.name === "string") skill.name = parsed.name.trim();
                if (typeof parsed.description === "string") {
                  skill.description = parsed.description.trim();
                }
                if (typeof parsed.content === "string") skill.content = parsed.content;
                if (typeof parsed.autoinvoke === "boolean") skill.autoinvoke = parsed.autoinvoke;
                if (typeof parsed.enabled === "boolean") skill.enabled = parsed.enabled;
                if (parsed.containerTag !== undefined) {
                  skill.containerTag = parsed.containerTag;
                }
                skill.updatedAt = new Date().toISOString();
                sendJson(res, 200, { success: true, data: skill });
              } catch (error) {
                sendJson(res, 400, {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            });
            return;
          }

          if (skillIdMatch && method === "DELETE") {
            const id = decodeURIComponent(skillIdMatch[1]);
            const before = skills.length;
            skills = skills.filter((skill) => skill.id !== id);
            if (skills.length === before) {
              sendJson(res, 404, { success: false, error: "Skill not found" });
              return;
            }
            sendJson(res, 200, { success: true, data: { deleted: true } });
            return;
          }

          // Other mutations: acknowledge without persistence.
          if (method !== "GET" && method !== "HEAD") {
            sendJson(res, 200, stubOk());
            return;
          }

          sendJson(res, 404, { success: false, error: `Sim route not found: ${pathname}` });
        } catch (error) {
          sendJson(res, 500, {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}
