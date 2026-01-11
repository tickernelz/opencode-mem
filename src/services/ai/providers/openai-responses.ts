import { BaseAIProvider, type ToolCallResult } from "./base-provider.js";
import { AISessionManager } from "../session/ai-session-manager.js";
import { ToolSchemaConverter, type ChatCompletionTool } from "../tools/tool-schema.js";
import { log } from "../../logger.js";

interface ResponsesAPIOutput {
  id: string;
  object: string;
  model: string;
  output: Array<{
    type: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: any;
  }>;
  conversation?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export class OpenAIResponsesProvider extends BaseAIProvider {
  private aiSessionManager: AISessionManager;

  constructor(config: any, aiSessionManager: AISessionManager) {
    super(config);
    this.aiSessionManager = aiSessionManager;
  }

  getProviderName(): string {
    return "openai-responses";
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
    let session = this.aiSessionManager.getSession(sessionId, "openai-responses");

    if (!session) {
      session = this.aiSessionManager.createSession({
        provider: "openai-responses",
        sessionId,
      });
    }

    let conversationId = session.conversationId;
    let currentPrompt = userPrompt;
    let iterations = 0;

    while (iterations < this.config.maxIterations) {
      iterations++;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.iterationTimeout);

      try {
        const tool = ToolSchemaConverter.toResponsesAPI(toolSchema);

        const requestBody: any = {
          model: this.config.model,
          input: currentPrompt,
          tools: [tool],
        };

        if (conversationId) {
          requestBody.conversation = conversationId;
        } else {
          requestBody.instructions = systemPrompt;
        }

        const response = await fetch(`${this.config.apiUrl}/responses`, {
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
          log("OpenAI Responses API error", {
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

        const data = (await response.json()) as ResponsesAPIOutput;

        conversationId = data.conversation || conversationId;

        if (iterations === 1) {
          const userSeq = this.aiSessionManager.getLastSequence(session.id) + 1;
          this.aiSessionManager.addMessage({
            aiSessionId: session.id,
            sequence: userSeq,
            role: "user",
            content: userPrompt,
          });
        }

        const toolCall = this.extractToolCall(data, toolSchema.function.name);

        if (toolCall) {
          this.aiSessionManager.updateSession(sessionId, "openai-responses", {
            conversationId,
          });

          return {
            success: true,
            data: this.validateResponse(toolCall),
            iterations,
          };
        }

        log("No tool call found, retrying", {
          iteration: iterations,
          expectedTool: toolSchema.function.name,
        });

        currentPrompt = this.buildRetryPrompt(data);
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

  private extractToolCall(data: ResponsesAPIOutput, expectedToolName: string): any | null {
    if (!data.output || !Array.isArray(data.output)) {
      log("Extract tool call: no output array", { hasOutput: !!data.output });
      return null;
    }

    for (const item of data.output) {
      if (item.type === "function_call" && item.name === expectedToolName) {
        if (item.arguments) {
          try {
            const parsed = JSON.parse(item.arguments);
            return parsed;
          } catch (error) {
            log("Failed to parse function call arguments", {
              error: String(error),
              toolName: item.name,
              arguments: item.arguments,
            });
            return null;
          }
        } else {
          log("Function call found but no arguments", {
            toolName: item.name,
            callId: item.call_id,
          });
        }
      }
    }

    log("No matching function call found", {
      expectedTool: expectedToolName,
      foundTypes: data.output.map((item) => item.type),
      foundNames: data.output.map((item) => item.name).filter(Boolean),
    });

    return null;
  }

  private buildRetryPrompt(data: ResponsesAPIOutput): string {
    let assistantResponse = "";

    if (data.output && Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item.type === "message" && item.content) {
          assistantResponse =
            typeof item.content === "string" ? item.content : JSON.stringify(item.content);
          break;
        }
      }
    }

    return `Previous response: ${assistantResponse}\n\nPlease use the save_memories tool to extract and save the memories from the conversation as instructed.`;
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
