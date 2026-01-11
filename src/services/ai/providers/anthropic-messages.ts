import { BaseAIProvider, type ToolCallResult } from "./base-provider.js";
import { SessionStore } from "../session/session-store.js";
import { ToolSchemaConverter, type ChatCompletionTool } from "../tools/tool-schema.js";
import { log } from "../../logger.js";

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string; [key: string]: any }>;
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: any;
  }>;
  model: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export class AnthropicMessagesProvider extends BaseAIProvider {
  private sessionStore: SessionStore;

  constructor(config: any, sessionStore: SessionStore) {
    super(config);
    this.sessionStore = sessionStore;
  }

  getProviderName(): string {
    return "anthropic";
  }

  supportsSession(): boolean {
    return true;
  }

  async executeToolCall(
    systemPrompt: string,
    userPrompt: string,
    toolSchema: ChatCompletionTool,
    sessionId: string
  ): Promise<ToolCallResult> {
    const session = this.sessionStore.getSession(sessionId, "anthropic");
    const messages: AnthropicMessage[] = session?.messageHistory || [];

    messages.push({
      role: "user",
      content: userPrompt,
    });

    let iterations = 0;
    const maxIterations = this.config.maxIterations;

    while (iterations < maxIterations) {
      iterations++;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.iterationTimeout);

      try {
        const tool = ToolSchemaConverter.toAnthropic(toolSchema);

        const requestBody = {
          model: this.config.model,
          max_tokens: 4096,
          system: systemPrompt,
          messages,
          tools: [tool],
        };

        const response = await fetch(`${this.config.apiUrl}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.config.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errorText = await response.text().catch(() => response.statusText);
          log("Anthropic Messages API error", {
            status: response.status,
            error: errorText,
            iteration: iterations,
          });
          return {
            success: false,
            error: `API error: ${response.status} - ${errorText}`,
            iterations,
          };
        }

        const data = (await response.json()) as AnthropicResponse;

        messages.push({
          role: "assistant",
          content: data.content,
        });

        const toolUse = this.extractToolUse(data, toolSchema.function.name);

        if (toolUse) {
          if (!session) {
            this.sessionStore.createSession({
              provider: "anthropic",
              sessionId,
              metadata: { messageCount: messages.length },
            });
          }

          this.sessionStore.updateSession(sessionId, "anthropic", {
            messageHistory: messages,
            lastResponseId: data.id,
          });

          return {
            success: true,
            data: this.validateResponse(toolUse),
            iterations,
          };
        }

        if (data.stop_reason === "end_turn") {
          messages.push({
            role: "user",
            content: "Please use the save_memories tool to extract and sries from the conversation as instructed.",
          });
        } else {
          break;
        }
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof Error && error.name === "AbortError") {
          return {
            success: false,
            error: `API request timeout (${this.config.iterationTimeout}ms)`,
            iterations,
          };
        }
        return {
          success: false,
          error: String(error),
          iterations,
        };
      }
    }

    return {
      success: false,
      error: `Max iterations (${maxIterations}) reachedut tool use`,
      iterations,
    };
  }

  private extractToolUse(data: AnthropicResponse, expectedToolName: string): any | null {
    if (!data.content || !Array.isArray(data.content)) {
      return null;
    }

    for (const block of data.content) {
      if (block.type === "tool_use" && block.name === expectedToolName && block.input) {
        return block.input;
      }
    }

    return null;
  }

  private validateResponse(data: any): any {
    if (!data || typeof data !== "object") {
      throw new Error("Response is not an object");
    }

    if (!Array.isArray(data.memories)) {
      throw new Error("memories field is not an array");
    }

    const validMemories = data.memories.filter((m: any) => {
      return (
        m &&
        typeof m === "object" &&
        typeof m.summary === "string" &&
        m.summary.trim().length > 0 &&
        (m.scope === "user" || m.scope === "project") &&
        typeof m.type === "string" &&
        m.type.trim().length > 0
      );
    });

    if (validMemories.length === 0) {
      throw new Error("No valid memories in response");
    }

    return { memories: validMemories };
  }
}
