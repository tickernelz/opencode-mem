import {
  ArrowDown,
  ArrowUp,
  PenLine,
  Link as LinkIcon,
  MessageCircle,
  Pin,
  Trash2,
} from "lucide-react";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Checkbox } from "$lib/components/ui/checkbox";
import { formatDate } from "$lib/format";
import { useI18n } from "$lib/i18n";
import { renderMarkdown } from "$lib/markdown";
import type { MemoryItem } from "$lib/types";

type Props = {
  variant: "memory" | "prompt" | "pair";
  item?: MemoryItem;
  memory?: MemoryItem;
  prompt?: MemoryItem;
  selected?: boolean;
  onSelect?: (id: string, selected: boolean) => void;
  onPin?: (id: string) => void;
  onUnpin?: (id: string) => void;
  onEdit?: (id: string) => void;
  onDeleteMemory?: (id: string, isLinked: boolean) => void;
  onDeletePrompt?: (id: string, isLinked: boolean) => void;
};

function displayInfo(m: MemoryItem): string {
  if (m.projectPath) {
    const pathParts = m.projectPath
      .replace(/\\/g, "/")
      .split("/")
      .filter((p) => p);
    return pathParts[pathParts.length - 1] || m.projectPath;
  }
  return m.displayName || m.id;
}

function dateInfo(m: MemoryItem) {
  const createdDate = formatDate(m.createdAt);
  const updatedDate = m.updatedAt && m.updatedAt !== m.createdAt ? formatDate(m.updatedAt) : null;
  return { createdDate, updatedDate };
}

function similarityLabel(m: MemoryItem, asFraction: boolean): string | null {
  if (m.similarity === undefined) return null;
  if (asFraction) return `${Math.round(m.similarity * 100)}%`;
  return `${m.similarity}%`;
}

export function MemoryCard({
  variant,
  item,
  memory,
  prompt,
  selected = false,
  onSelect,
  onPin,
  onUnpin,
  onEdit,
  onDeleteMemory,
  onDeletePrompt,
}: Props) {
  const { t } = useI18n();

  if (variant === "pair" && memory && prompt) {
    const pinned = memory.isPinned || false;
    const dates = dateInfo(memory);
    const sim = similarityLabel(memory, true);
    return (
      <div
        className={`rounded-xl border border-border bg-card/60 p-3 space-y-3 ${
          selected ? "ring-1 ring-primary/50" : ""
        } ${pinned ? "border-primary/40" : ""}`}
        data-id={memory.id}
      >
        <div className="space-y-2 rounded-lg bg-muted/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <Badge variant="secondary">{t("badge-prompt")}</Badge>
            <span className="text-xs text-muted-foreground">{formatDate(prompt.createdAt)}</span>
          </div>
          <p className="text-sm whitespace-pre-wrap break-words">{prompt.content}</p>
        </div>

        <div className="flex justify-center text-muted-foreground">
          <ArrowDown className="size-4" />
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
              <Checkbox
                checked={selected}
                onCheckedChange={(v) => onSelect?.(memory.id, v === true)}
              />
              <Badge>{t("badge-memory")}</Badge>
              {memory.memoryType ? <Badge variant="outline">{memory.memoryType}</Badge> : null}
              {sim ? <span className="text-xs text-primary">{sim}</span> : null}
              {pinned ? <Badge variant="secondary">{t("badge-pinned")}</Badge> : null}
              <span className="text-xs text-muted-foreground truncate">
                {memory.displayName || memory.id}
              </span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {pinned ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="Unpin"
                  onClick={() => onUnpin?.(memory.id)}
                >
                  <Pin className="size-3.5 fill-current" />
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="Pin"
                  onClick={() => onPin?.(memory.id)}
                >
                  <Pin className="size-3.5" />
                </Button>
              )}
              <Button variant="ghost" size="icon-xs" onClick={() => onEdit?.(memory.id)}>
                <PenLine className="size-3.5" />
              </Button>
              <Button
                variant="destructive"
                size="xs"
                onClick={() => onDeleteMemory?.(memory.id, true)}
              >
                <Trash2 className="size-3.5" />
                {t("btn-delete-pair")}
              </Button>
            </div>
          </div>
          {memory.tags?.length ? (
            <div className="flex flex-wrap gap-1">
              {memory.tags.map((tag) => (
                <Badge key={tag} variant="outline" className="font-normal">
                  {tag}
                </Badge>
              ))}
            </div>
          ) : null}
          <div
            className="markdown-content text-sm prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(memory.content) }}
          />
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            <span>
              {t("date-created")} {dates.createdDate}
            </span>
            {dates.updatedDate ? (
              <span>
                {t("date-updated")} {dates.updatedDate}
              </span>
            ) : null}
            <span>ID: {memory.id}</span>
          </div>
        </div>
      </div>
    );
  }

  if (variant === "prompt" && item) {
    const isLinked = !!item.linkedMemoryId;
    return (
      <div
        className={`rounded-xl border border-border bg-card/60 p-3 space-y-2 ${
          selected ? "ring-1 ring-primary/50" : ""
        }`}
        data-id={item.id}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Checkbox checked={selected} onCheckedChange={(v) => onSelect?.(item.id, v === true)} />
            <MessageCircle className="size-3.5 text-muted-foreground" />
            <Badge variant="secondary">{t("badge-prompt")}</Badge>
            {isLinked ? (
              <Badge variant="outline">
                <LinkIcon className="size-3" />
                {t("badge-linked")}
              </Badge>
            ) : null}
            <span className="text-xs text-muted-foreground">{formatDate(item.createdAt)}</span>
          </div>
          <Button
            variant="destructive"
            size="xs"
            onClick={() => onDeletePrompt?.(item.id, isLinked)}
          >
            <Trash2 className="size-3.5" />
            {isLinked ? t("btn-delete-pair") : t("btn-delete")}
          </Button>
        </div>
        <p className="text-sm whitespace-pre-wrap break-words">{item.content}</p>
        {isLinked ? (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <ArrowDown className="size-3" />
            {t("text-generated-above")}
            <ArrowUp className="size-3" />
          </div>
        ) : null}
      </div>
    );
  }

  if (variant === "memory" && item) {
    const pinned = item.isPinned || false;
    const isLinked = !!item.linkedPromptId;
    const dates = dateInfo(item);
    const sim = similarityLabel(item, false);
    return (
      <div
        className={`rounded-xl border border-border bg-card/60 p-3 space-y-2 ${
          selected ? "ring-1 ring-primary/50" : ""
        } ${pinned ? "border-primary/40" : ""}`}
        data-id={item.id}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            <Checkbox checked={selected} onCheckedChange={(v) => onSelect?.(item.id, v === true)} />
            {item.memoryType ? <Badge variant="outline">{item.memoryType}</Badge> : null}
            {isLinked ? (
              <Badge variant="outline">
                <LinkIcon className="size-3" />
                {t("badge-linked")}
              </Badge>
            ) : null}
            {sim ? <span className="text-xs text-primary">{sim}</span> : null}
            {pinned ? <Badge variant="secondary">{t("badge-pinned")}</Badge> : null}
            <span className="text-xs text-muted-foreground truncate">{displayInfo(item)}</span>
            {item.projectPath ? (
              <span className="text-xs text-muted-foreground/70 truncate w-full">
                {item.projectPath}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {pinned ? (
              <Button
                variant="ghost"
                size="icon-xs"
                title="Unpin"
                onClick={() => onUnpin?.(item.id)}
              >
                <Pin className="size-3.5 fill-current" />
              </Button>
            ) : (
              <Button variant="ghost" size="icon-xs" title="Pin" onClick={() => onPin?.(item.id)}>
                <Pin className="size-3.5" />
              </Button>
            )}
            <Button variant="ghost" size="icon-xs" onClick={() => onEdit?.(item.id)}>
              <PenLine className="size-3.5" />
            </Button>
            <Button
              variant="destructive"
              size="xs"
              onClick={() => onDeleteMemory?.(item.id, isLinked)}
            >
              <Trash2 className="size-3.5" />
              {isLinked ? t("btn-delete-pair") : t("btn-delete")}
            </Button>
          </div>
        </div>
        {item.tags?.length ? (
          <div className="flex flex-wrap gap-1">
            {item.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="font-normal">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
        <div
          className="markdown-content text-sm prose-invert max-w-none"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(item.content) }}
        />
        {isLinked ? (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <ArrowUp className="size-3" />
            {t("text-from-below")}
            <ArrowDown className="size-3" />
          </div>
        ) : null}
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span>
            {t("date-created")} {dates.createdDate}
          </span>
          {dates.updatedDate ? (
            <span>
              {t("date-updated")} {dates.updatedDate}
            </span>
          ) : null}
          <span>ID: {item.id}</span>
        </div>
      </div>
    );
  }

  return null;
}
