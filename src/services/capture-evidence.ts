import { userPromptManager } from "./user-prompt/user-prompt-manager.js";
import { sanitizeMemoryContent, isFullyPrivate } from "./privacy.js";
import { utf8ByteLength } from "../utils/context-limit.js";
import { isCaptureEvidenceEvent } from "./capture-evidence-events.js";

const MAX_BINDINGS = 128;
const MAX_TEXT_BYTES = 65536;
interface Binding {
  promptId: string;
  texts: Map<string, string>;
  tools: Map<string, string>;
  textFull: boolean;
}

/** Stream-ordered bindings prevent a queued next prompt from stealing earlier results. */
export class CaptureEvidenceRecorder {
  private delivered = new Map<string, string>();
  private bindings = new Map<string, Binding>();
  /** After idle/deleted, refuse new binds until the next authored user input. */
  private sealed = new Set<string>();
  private chain: Promise<void> = Promise.resolve();

  constructor(private directory: string) {}

  observe(event: { type: string; properties?: any }): Promise<void> {
    if (!isCaptureEvidenceEvent(event.type)) return Promise.resolve();
    const next = this.chain.then(() => this.record(event));
    // Never reject to callers: deleted-session capture must still run after a
    // best-effort checkpoint even if one evidence write fails.
    this.chain = next.catch(() => {});
    return this.chain;
  }

  async drain(): Promise<void> {
    await this.chain;
    this.delivered.clear();
    this.bindings.clear();
    this.sealed.clear();
  }

  private trim(map: Map<string, unknown>): void {
    while (map.size > MAX_BINDINGS) map.delete(map.keys().next().value!);
  }

  private async bind(sessionID: string, assistantID: string, messageID: string): Promise<void> {
    if (this.sealed.has(sessionID)) return;
    const key = `${sessionID}:${assistantID}`;
    if (this.bindings.has(key)) return;
    const prompt = await userPromptManager.getPendingPromptForMessage(
      sessionID,
      messageID,
      this.directory
    );
    if (!prompt || isFullyPrivate(prompt.content)) return;
    this.bindings.set(key, {
      promptId: prompt.id,
      texts: new Map(),
      tools: new Map(),
      textFull: false,
    });
    this.trim(this.bindings);
  }

  private async text(
    binding: Binding,
    assistantID: string,
    key: string,
    text: string
  ): Promise<void> {
    if (binding.textFull || typeof text !== "string") return;
    const parts = new Map(binding.texts);
    parts.set(key, text);
    // Keep a bounded raw in-memory prefix solely to redact tags spanning final
    // text parts. No raw buffer is persisted. Stop, rather than retain a tail
    // that could lose an opening <private> marker.
    if (parts.size > 32 || utf8ByteLength([...parts.values()].join("\n")) > MAX_TEXT_BYTES) {
      binding.textFull = true;
      binding.texts.clear();
      const clean = sanitizeMemoryContent([...parts.values()].join("\n"));
      await userPromptManager.saveCaptureEvidence(
        binding.promptId,
        this.directory,
        `${assistantID}:text`,
        isFullyPrivate(clean) ? clean : `Assistant text (bounded observations):\n${clean}`
      );
      return;
    }
    binding.texts = parts;
    const clean = sanitizeMemoryContent([...parts.values()].join("\n"));
    await userPromptManager.saveCaptureEvidence(
      binding.promptId,
      this.directory,
      `${assistantID}:text`,
      isFullyPrivate(clean) ? clean : `Assistant text (observed):\n${clean}`
    );
  }

  private async tool(
    binding: Binding,
    assistantID: string,
    id: string,
    name: string,
    status: string,
    text: string
  ): Promise<void> {
    // No tool inputs: results are evidence, arguments alone are not success.
    await userPromptManager.saveCaptureEvidence(
      binding.promptId,
      this.directory,
      `${assistantID}:tool:${id}`,
      sanitizeMemoryContent(
        `Tool ${sanitizeMemoryContent(typeof name === "string" ? name : "tool").slice(0, 128)} (${status}):\n${text}`
      )
    );
  }

  private async record(event: { type: string; properties?: any }): Promise<void> {
    const data = event.properties ?? {};
    const sessionID =
      data.sessionID ??
      data.info?.sessionID ??
      data.part?.sessionID ??
      (event.type === "session.deleted" ? data.info?.id : undefined);
    if (typeof sessionID !== "string") return;
    if (event.type === "session.inbox.delivered") {
      // A new authored input opens the next turn after an idle/deleted seal.
      this.sealed.delete(sessionID);
      // Always replace/clear, even for synthetic or private/untracked inputs.
      this.delivered.delete(sessionID);
      if (typeof data.inboxID === "string") this.delivered.set(sessionID, data.inboxID);
      this.trim(this.delivered);
      return;
    }
    if (event.type === "message.updated" && data.info?.role === "user") {
      // V1 has no inbox.delivered; a new user message unseals the next turn.
      this.sealed.delete(sessionID);
      return;
    }
    if (event.type === "session.step.started") {
      const messageID = this.delivered.get(sessionID);
      if (messageID && typeof data.assistantMessageID === "string") {
        await this.bind(sessionID, data.assistantMessageID, messageID);
      }
      return;
    }
    if (event.type === "message.updated") {
      const info = data.info;
      if (
        info?.role === "assistant" &&
        typeof info.id === "string" &&
        typeof info.parentID === "string" &&
        !info.summary
      ) {
        const key = `${sessionID}:${info.id}`;
        if (!this.bindings.has(key)) await this.bind(sessionID, info.id, info.parentID);
      }
      return;
    }
    if (event.type === "session.idle" || event.type === "session.deleted") {
      await userPromptManager.markCaptureEvidenceReady(sessionID, this.directory);
      this.delivered.delete(sessionID);
      for (const key of this.bindings.keys())
        if (key.startsWith(`${sessionID}:`)) this.bindings.delete(key);
      // Seal so buffered late parts cannot rebind and flip ready back to 0.
      this.sealed.add(sessionID);
      return;
    }
    const part = data.part;
    const assistantID = data.assistantMessageID ?? part?.messageID;
    if (typeof assistantID !== "string") return;
    const binding = this.bindings.get(`${sessionID}:${assistantID}`);
    if (!binding) return; // Never guess the latest prompt after a missed event.
    if (event.type === "session.text.ended") {
      await this.text(binding, assistantID, String(data.ordinal), data.text);
    } else if (event.type === "session.tool.input.started") {
      if (typeof data.id === "string" && typeof data.name === "string") {
        binding.tools.set(data.id, data.name);
        while (binding.tools.size > 32) binding.tools.delete(binding.tools.keys().next().value!);
      }
    } else if (event.type === "session.tool.success" || event.type === "session.tool.failed") {
      if (typeof data.id !== "string") return;
      const text = Array.isArray(data.content)
        ? data.content
            .filter((p: any) => p?.type === "text" && typeof p.text === "string")
            .map((p: any) => p.text)
            .join("\n")
        : "";
      // The terminal state is useful even if the host exposes no text result.
      await this.tool(
        binding,
        assistantID,
        data.id,
        binding.tools.get(data.id) ?? "tool",
        event.type.endsWith("success") ? "completed" : "failed",
        text
      );
    } else if (event.type === "message.part.updated" && part && !part.synthetic && !part.ignored) {
      if (part.type === "text" && typeof part.time?.end === "number") {
        await this.text(binding, assistantID, String(part.id), part.text);
      } else if (part.type === "tool" && ["completed", "error"].includes(part.state?.status)) {
        const output = part.state.output ?? part.state.error;
        await this.tool(
          binding,
          assistantID,
          String(part.id),
          part.tool ?? part.name ?? "tool",
          part.state.status === "error" ? "failed" : "completed",
          typeof output === "string" ? output : ""
        );
      }
    }
  }
}
