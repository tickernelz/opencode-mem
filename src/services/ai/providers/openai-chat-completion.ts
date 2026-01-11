import { BaseAIProvider, type ToolCallResult } from "./base-provider.js";
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
  getProviderName(): string {
    return "openai-chat";
  }

  supportsSession(): boolean {
    return false;
  }

  async executeToolCall(
    systemPrompt: string,
    userPrompt: string,
    toolSchema: ChatCompletionTool,
    sessionId: string
  ): Promise<ToolCallResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.iterationTimeout);

    try {
      const requestBody = {
        model: this.config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
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

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        log("OpenAI Chat Completion API error", {
          status: response.status,
          error: errorText,
        });
        return {
          success: false,
          error: `API error: ${response.status} - ${errorText}`,
          iterations: 1,
        };
      }

      const data = (await response.json()) as ToolCallResponse;

      if (!data.choices || !data.choices[0]) {
        return {
          success: false,
          error: "Invalid API response format",
          iterations: 1,
        };
      }

      const choice = data.choices[0];

      if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
        log("OpenAI Chat Completion: tool calling not used", {
          finishReason: choice.finish_reason,
        });
        return {
          success: false,
          error: "Tool calling not supported or not used by provider",
          iterations: 1,
        };
      }

      const toolCall = choice.message.tool_calls[0];

      if (!toolCall || toolCall.function.name !== toolSchema.function.name) {
        return {
          success: false,
          error: "Invalid tool call response",
          iterations: 1,
        };
      }

      const parsed = JSON.parse(toolCall.function.arguments);

      return {
        success: true,
        data: this.validateResponse(parsed),
        iterations: 1,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return {
          success: false,
          error: `API request timeout (${this.config.iterationTimeout}ms)`,
          iterations: 1,
        };
      }
      return {
        success: false,
        error: String(error),
        iterations: 1,
      };
    } finally {
      clearTimeout(timeout);
    }
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
