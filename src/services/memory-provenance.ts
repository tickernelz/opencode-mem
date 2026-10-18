export function formatMemoryCreatedDate(value: unknown): string | null {
  let date: Date;

  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "number" || typeof value === "string") {
    date = new Date(value);
  } else {
    return null;
  }

  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function escapeXmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&apos;";
      default:
        return character;
    }
  });
}

type MemoryProvenance = {
  id?: unknown;
  createdAt?: unknown;
  projectName?: unknown;
};

export function buildMemoryProvenanceAttributes(mem: MemoryProvenance): string {
  const attributes: string[] = [];

  if (typeof mem.id === "string" && mem.id.trim()) {
    attributes.push(`id="${escapeXmlAttribute(mem.id)}"`);
  }

  const created = formatMemoryCreatedDate(mem.createdAt);
  if (created) attributes.push(`created="${created}"`);

  if (typeof mem.projectName === "string" && mem.projectName.trim()) {
    attributes.push(`project="${escapeXmlAttribute(mem.projectName)}"`);
  }

  return attributes.length > 0 ? ` ${attributes.join(" ")}` : "";
}

export function buildMemoryProvenanceSuffix(mem: MemoryProvenance): string {
  const parts: string[] = [];

  if (typeof mem.id === "string" && mem.id.trim()) parts.push(mem.id);

  const created = formatMemoryCreatedDate(mem.createdAt);
  if (created) parts.push(`created ${created}`);

  if (typeof mem.projectName === "string" && mem.projectName.trim()) {
    parts.push(mem.projectName);
  }

  return parts.length > 0 ? ` (${parts.join(" · ")})` : "";
}
