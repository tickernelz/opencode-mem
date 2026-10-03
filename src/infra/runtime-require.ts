/**
 * Create a CommonJS require() bound to the current ESM module.
 *
 * OpenCode ships as a Bun `--compile` binary. In that host, `import.meta.url`
 * can be empty for dynamically loaded plugins, so `createRequire(import.meta.url)`
 * yields `Cannot find module '…' from ''` (#210). Prefer Bun's module-bound
 * `import.meta.require` when available, then fall back to a valid file/path anchor.
 */
import { createRequire } from "node:module";
import { join } from "node:path";

export type RuntimeImportMeta = ImportMeta & {
  require?: NodeRequire;
  path?: string;
  dirname?: string;
  dir?: string;
  resolve?: (specifier: string) => string;
};

function isUsableAnchor(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value !== "undefined";
}

function collectAnchors(meta: RuntimeImportMeta): string[] {
  const anchors: string[] = [];
  if (isUsableAnchor(meta.url)) anchors.push(meta.url);
  if (isUsableAnchor(meta.path)) anchors.push(meta.path);

  const dir = isUsableAnchor(meta.dirname)
    ? meta.dirname
    : isUsableAnchor(meta.dir)
      ? meta.dir
      : null;
  if (dir) {
    // createRequire needs a filename, not a directory.
    anchors.push(join(dir, "runtime-require.js"));
  }

  if (typeof meta.resolve === "function") {
    try {
      const resolved = meta.resolve("./package.json");
      if (isUsableAnchor(resolved)) anchors.push(resolved);
    } catch {
      // import.meta.resolve may be unavailable or reject relative specifiers.
    }
  }
  return anchors;
}

/**
 * Build a require() for resolving/loading packages next to this plugin module.
 * Throws a concrete diagnostic when no usable Bun/Node anchor exists.
 *
 * Prefer a path/url-anchored createRequire over Bun's import.meta.require when a
 * concrete file anchor exists. In OpenCode's Bun --compile host, import.meta.url
 * and import.meta.path are still valid for dynamically imported plugins even when
 * some require referrers later surface as `from ''` (#210).
 */
export function createRuntimeRequire(meta: RuntimeImportMeta): NodeRequire {
  const anchors = collectAnchors(meta);
  const errors: string[] = [];
  for (const anchor of anchors) {
    try {
      return createRequire(anchor);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${anchor}: ${message}`);
    }
  }

  if (typeof meta.require === "function") {
    return meta.require;
  }

  throw new Error(
    [
      "Unable to create a module require for the OpenCode plugin host.",
      `import.meta.url=${JSON.stringify(meta.url)}`,
      `import.meta.path=${JSON.stringify(meta.path)}`,
      "Bun import.meta.require is unavailable.",
      errors.length > 0 ? `createRequire attempts: ${errors.join("; ")}` : null,
      "This usually means the compiled OpenCode/Bun host cleared the plugin module referrer (#210).",
    ]
      .filter(Boolean)
      .join(" ")
  );
}
