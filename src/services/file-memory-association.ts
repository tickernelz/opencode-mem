import { createHash } from "node:crypto";
import { isObservedFiles, type ObservedFiles } from "./observed-files.js";
import { sanitizeMemoryContent } from "./privacy.js";

export interface FileMemoryAssociation extends ObservedFiles {
  /** Invalidate the association when another workflow rewrites the memory. */
  contentHash: string;
}

/**
 * Require the saved lesson to name the observed file, not just a basename or a
 * substring of another path. Literal matching avoids interpreting filename
 * punctuation as a pattern. Quoted spans are whole references (including spaces);
 * bare references are whitespace-delimited with ordinary surrounding punctuation.
 * An optional ./ prefix is accepted; ambiguous spellings conservatively miss.
 * A mention is still a relevance hint, not proof the lesson applies to the file.
 */
function namedFiles(content: string): Set<string> {
  const paths = new Set<string>();
  for (const token of content.matchAll(/`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s`"']+)/gu)) {
    const quoted = token[1] ?? token[2] ?? token[3];
    let path = quoted ?? (token[4] ?? "").replace(/^[([{]+/u, "").replace(/[)\]},;:.]+$/u, "");
    if (path.startsWith("./")) path = path.slice(2);
    // An unquoted root filename such as `cache` is indistinguishable from an
    // ordinary word. Require quotes for this ambiguous class.
    if (quoted === undefined && !/[/.]/u.test(path)) continue;
    paths.add(path);
  }
  return paths;
}

export function bindFilesToMemory(
  observed: ObservedFiles | undefined,
  content: string
): FileMemoryAssociation | null {
  if (!isObservedFiles(observed)) return null;
  const sanitized = sanitizeMemoryContent(content);
  const named = namedFiles(sanitized);
  const paths = observed.paths.filter((path) => named.has(path));
  if (!paths.length) return null;
  return {
    version: 1,
    workspace: observed.workspace,
    paths,
    contentHash: createHash("sha256").update(sanitized).digest("hex"),
  };
}

/** A file observation is a retrieval signal, not proof that the memory is current. */
export function matchesFileMemory(
  metadata: Record<string, unknown> | undefined,
  content: string,
  observed: ObservedFiles
): boolean {
  if (metadata?.source !== "auto-capture") return false;
  const association = metadata.observedFiles;
  if (!isObservedFiles(association) || association.workspace !== observed.workspace) return false;
  const contentHash = (association as FileMemoryAssociation).contentHash;
  if (typeof contentHash !== "string" || !/^[a-f0-9]{64}$/.test(contentHash)) return false;
  if (contentHash !== createHash("sha256").update(content).digest("hex")) return false;
  // Recheck the particular requested path, including records saved by an older
  // build that associated every observed file. Do not mutate or backfill them.
  const named = namedFiles(sanitizeMemoryContent(content));
  return association.paths.some((path) => observed.paths.includes(path) && named.has(path));
}
