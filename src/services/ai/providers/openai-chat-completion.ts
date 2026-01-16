import { BaseAIProvider, type ToolCallResult } from "./base-provider.js";
import { AISessionManager } from "../session/ai-session-manager.js";
import type { ChatCompletionTool } from "../tools/tool-schema.js";
import { log } from "../../logger.js";
import { UserProfileValidator } from "../validators/user-profile-validator.js";

interface ToolCallResponse {
  choices: Array<{
    message: {
      content?: string;
      tool_calls?: Array<{
        id: string;
        type: string;
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

  private addToolResponse(
    sessionId: string,
    messages: any[],
    toolCallId: string,
    content: string
  ): void {
    const sequence = this.aiSessionManager.getLastSequence(sessionId) + 1;
    this.aiSessionManager.addMessage({
      aiSessionId: sessionId,
      sequence,
      role: "tool",
      content,
      toolCallId,
    });
    messages.push({
      role: "tool",
      tool_call_id: toolCallId,
      content,
    });
  }

  private filterIncompleteToolCallSequences(messages: any[]): any[] {
    const result: any[] = [];
    let i = 0;

    while (i < messages.length) {
      const msg = messages[i];

      if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
        const toolCallIds = new Set(msg.toolCalls.map((tc: any) => tc.id));
        const toolResponses: any[] = [];
        let j = i + 1;

        while (j < messages.length && messages[j].role === "tool") {
          if (toolCallIds.has(messages[j].toolCallId)) {
            toolResponses.push(messages[j]);
            toolCallIds.delete(messages[j].toolCallId);
          }
          j++;
        }

        if (toolCallIds.size === 0) {
          result.push(msg);
          toolResponses.forEach((tr) => result.push(tr));
          i = j;
        } else {
          log("Skipping incomplete tool call sequence", {
            assistantMsgIndex: i,
            missingToolCallIds: Array.from(toolCallIds),
          });
          break;
        }
      } else {
        result.push(msg);
        i++;
      }
    }

    return result;
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

    const validatedMessages = this.filterIncompleteToolCallSequences(existingMessages);

    for (const msg of validatedMessages) {
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
          tool_choice: { type: "function", function: { name: toolSchema.function.name } },
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
          for (const toolCall of choice.message.tool_calls) {
            const toolCallId = toolCall.id;

            if (toolCall.function.name === toolSchema.function.name) {
              try {
                const parsed = JSON.parse(toolCall.function.arguments);
                const result = UserProfileValidator.validate(parsed);
                if (!result.valid) {
                  throw new Error(result.errors.join(", "));
                }

                this.addToolResponse(
                  session.id,
                  messages,
                  toolCallId,
                  JSON.stringify({ success: true })
                );

                return {
                  success: true,
                  data: result.data,
                  iterations,
                };
              } catch (validationError) {
                const errorStack =
                  validationError instanceof Error ? validationError.stack : undefined;
                log("OpenAI tool response validation failed", {
                  error: String(validationError),
                  stack: errorStack,
                  errorType:
                    validationError instanceof Error
                      ? validationError.constructor.name
                      : typeof validationError,
                  toolName: toolSchema.function.name,
                  iteration: iterations,
                  rawArguments: toolCall.function.arguments.slice(0, 500),
                });

                const errorMessage = `Validation failed: ${String(validationError)}`;
                this.addToolResponse(
                  session.id,
                  messages,
                  toolCallId,
                  JSON.stringify({ success: false, error: errorMessage })
                );

                return {
                  success: false,
                  error: errorMessage,
                  iterations,
                };
              }
            }

            const wrongToolMessage = `Wrong tool called. Please use ${toolSchema.function.name} instead.`;
            this.addToolResponse(
              session.id,
              messages,
              toolCallId,
              JSON.stringify({ success: false, error: wrongToolMessage })
            );

            break;
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
}
