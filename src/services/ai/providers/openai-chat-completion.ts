import { BaseAIProvider, type ToolCallResult } from "./base-provider.js";
import { AISessionManager } from "../session/ai-session-manager.js";
import type { ChatCompletionTool } from "../tools/tool-schema.js";
import { log } from "../../logger.js";

interface ToolCallResponse {
  choices: Array<{
    message: {
      content?: string;
      tool_calls?: Array<{
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
}

export class OpenAIChatCompletionProvider extends BaseAIProvider {
  private aiSessionManager: AISessionManager;

  constructor(config: any, aiSessionManager: AISessionManager) {
    super(config);
    this.aiSessionManager = aiSessionManager;
  }

  getProviderName(): string {
    return "openai-chat";
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
    let session = this.aiSessionManager.getSession(sessionId, "openai-chat");

    if (!session) {
      session = this.aiSessionManager.createSession({
        provider: "openai-chat",
        sessionId,
      });
    }

    const existingMessages = this.aiSessionManager.getMessages(session.id);
    const messages: any[] = [];

    for (const msg of existingMessages) {
      const apiMsg: any = {
        role: msg.role,
        content: msg.content,
      };

      if (msg.toolCalls) {
        apiMsg.tool_calls = msg.toolCalls;
      }

      if (msg.toolCallId) {
        apiMsg.tool_call_id = msg.toolCallId;
      }

      messages.push(apiMsg);
    }

    if (messages.length === 0) {
      const sequence = this.aiSessionManager.getLastSequence(session.id) + 1;
      this.aiSessionManager.addMessage({
        aiSessionId: session.id,
        sequence,
        role: "system",
        content: systemPrompt,
      });

      messages.push({ role: "system", content: systemPrompt });
    }

    const userSequence = this.aiSessionManager.getLastSequence(session.id) + 1;
    this.aiSessionManager.addMessage({
      aiSessionId: session.id,
      sequence: userSequence,
      role: "user",
      content: userPrompt,
    });

    messages.push({ role: "user", content: userPrompt });

    let iterations = 0;

    while (iterations < this.config.maxIterations) {
      iterations++;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.iterationTimeout);

      try {
        const requestBody = {
          model: this.config.model,
          messages,
          tools: [toolSchema],
          tool_choice: { type: "function", name: toolSchema.function.name },
          temperature: 0.3,
        };

        const response = await fetch(`${this.config.apiUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errorText = await response.text().catch(() => response.statusText);
          log("OpenAI Chat Completion API error", {
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

        const data = (await response.json()) as ToolCallResponse;

        if (!data.choices || !data.choices[0]) {
          return {
            success: false,
            error: "Invalid API response format",
            iterations,
          };
        }

        const choice = data.choices[0];

        const assistantSequence = this.aiSessionManager.getLastSequence(session.id) + 1;
        const assistantMsg: any = {
          aiSessionId: session.id,
          sequence: assistantSequence,
          role: "assistant",
          content: choice.message.content || "",
        };

        if (choice.message.tool_calls) {
          assistantMsg.toolCalls = choice.message.tool_calls;
        }

        this.aiSessionManager.addMessage(assistantMsg);
        messages.push(choice.message);

        if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
          const toolCall = choice.message.tool_calls[0];

          if (toolCall && toolCall.function.name === toolSchema.function.name) {
            const parsed = JSON.parse(toolCall.function.arguments);
            return {
              success: true,
              data: this.validateResponse(parsed),
              iterations,
            };
          }
        }

        const retrySequence = this.aiSessionManager.getLastSequence(session.id) + 1;
        const retryPrompt =
          "Please use the save_memories tool to extract and save the memories from the conversation as instructed.";

        this.aiSessionManager.addMessage({
          aiSessionId: session.id,
          sequence: retrySequence,
          role: "user",
          content: retryPrompt,
        });

        messages.push({ role: "user", content: retryPrompt });
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
      error: `Max iterations (${this.config.maxIterations}) reached without tool call`,
      iterations,
    };
  }

  private validateResponse(data: any): any {
    if (!data || typeof data !== "object") {
      throw new Error("Response is not an object");
    }

    if (data.memories && Array.isArray(data.memories)) {
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

    if (data.summary && typeof data.summary === "string" && data.summary.trim().length > 0) {
      return data;
    }

    throw new Error("Invalid response format: missing summary or memories field");
  }
}
