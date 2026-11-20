export const ROUTES = {
  home: "/",
  project: "/project-memories",
  profile: "/user-profile",
  // Keep off `/skills` — that prefix serves the OpenCode HTTP skill catalog.
  skills: "/skill-library",
  markdown: "/markdown-vault",
  stats: "/stats",
  model: "/model-settings",
} as const;

export type AppView = "project" | "profile" | "skills" | "markdown" | "stats" | "model";

export function normalizePath(pathname: string): string {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path.startsWith("/") ? path : `/${path}`;
}

export function viewFromPath(pathname: string): AppView {
  const path = normalizePath(pathname);
  if (path === ROUTES.profile) return "profile";
  if (path === ROUTES.skills) return "skills";
  if (path === ROUTES.markdown) return "markdown";
  if (path === ROUTES.stats) return "stats";
  if (path === ROUTES.model) return "model";
  return "project";
}

export function pathForView(view: AppView): string {
  if (view === "profile") return ROUTES.profile;
  if (view === "skills") return ROUTES.skills;
  if (view === "markdown") return ROUTES.markdown;
  if (view === "stats") return ROUTES.stats;
  if (view === "model") return ROUTES.model;
  return ROUTES.project;
}

export function isAppPath(pathname: string): boolean {
  const path = normalizePath(pathname);
  return (
    path === ROUTES.home ||
    path === ROUTES.project ||
    path === ROUTES.profile ||
    path === ROUTES.skills ||
    path === ROUTES.markdown ||
    path === ROUTES.stats ||
    path === ROUTES.model
  );
}

/** Canonical app path — `/` redirects to project memories. */
export function resolveAppPath(pathname: string): string {
  const path = normalizePath(pathname);
  if (path === ROUTES.home) return ROUTES.project;
  if (
    path === ROUTES.project ||
    path === ROUTES.profile ||
    path === ROUTES.skills ||
    path === ROUTES.markdown ||
    path === ROUTES.stats ||
    path === ROUTES.model
  )
    return path;
  return ROUTES.project;
}
