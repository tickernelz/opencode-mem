import {
  BaseAIProvider,
  type ProviderConfig,
  type ToolCallResult,
  applySafeExtraParams,
} from "./base-provider.js";
import type { AISessionManager } from "../session/ai-session-manager.js";
import type { AIMessage } from "../session/session-types.js";
import type { ChatCompletionTool } from "../tools/tool-schema.js";
import { log } from "../../logger.js";
import { UserProfileValidator } from "../validators/user-profile-validator.js";

interface ToolCallResponse {
  choices: Array<{
    message: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
}

type APIMessage = {
  role: AIMessage["role"];
  content: string | null;
  tool_calls?: ToolCallResponse["choices"][number]["message"]["tool_calls"];
  tool_call_id?: string;
};

type RequestBody = {
  model: string;
  messages: APIMessage[];
  tools: ChatCompletionTool[];
  tool_choice: "auto";
  temperature?: number;
  [key: string]: unknown;
};

type AssistantSessionMessage = Omit<AIMessage, "id" | "createdAt">;

function isErrorResponseBody(data: unknown): data is { status: string; msg: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { status?: unknown }).status === "string" &&
    typeof (data as { msg?: unknown }).msg === "string"
  );
}

function hasNonEmptyChoices(data: unknown): data is ToolCallResponse {
  if (typeof data !== "object" || data === null) return false;
  const { choices } = data as { choices?: unknown };
  if (!Array.isArray(choices) || choices.length === 0) return false;

  const first = choices[0] as { message?: unknown };
  if (typeof first !== "object" || first === null) return false;
  if (typeof first.message !== "object" || first.message === null) return false;

  const { content, tool_calls } = first.message as { content?: unknown; tool_calls?: unknown };
  if (content !== undefined && content !== null && typeof content !== "string") return false;
  if (tool_calls !== undefined && !Array.isArray(tool_calls)) return false;

  return true;
}

function extractFirstJSON(raw: string): string | null {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{" || raw[i] === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (raw[i] === "}" || raw[i] === "]") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function repairInnerQuotes(json: string): string {
  let result = json.replace(
    /([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])"([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])/g,
    '$1\\"$2'
  );
  result = result.replace(/([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])"(?=\s*[,}\]])/g, '$1\\"');
  return result;
}

export class OpenAIChatCompletionProvider extends BaseAIProvider {
  private readonly aiSessionManager: AISessionManager;

  constructor(config: ProviderConfig, aiSessionManager: AISessionManager) {
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
    messages: APIMessage[],
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

  protected filterIncompleteToolCallSequences(messages: AIMessage[]): AIMessage[] {
    const result: AIMessage[] = [];
    let i = 0;

    while (i < messages.length) {
      const msg = messages[i];
      if (!msg) {
        break;
      }

      if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
        const toolCallIds = new Set(msg.toolCalls.map((tc) => tc.id));
        const toolResponses: AIMessage[] = [];
        let j = i + 1;

        while (j < messages.length && messages[j]?.role === "tool") {
          const toolMessage = messages[j];
          if (toolMessage?.toolCallId && toolCallIds.has(toolMessage.toolCallId)) {
            toolResponses.push(toolMessage);
            toolCallIds.delete(toolMessage.toolCallId);
          }
          j++;
        }

        if (toolCallIds.size === 0) {
          result.push(msg);
          toolResponses.forEach((tr) => result.push(tr));
          i = j;
        } else {
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
    const messages: APIMessage[] = [];

    const validatedMessages = this.filterIncompleteToolCallSequences(existingMessages);

    for (const msg of validatedMessages) {
      const apiMsg: APIMessage = {
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
    const maxIterations = this.config.maxIterations ?? 5;
    const iterationTimeout = this.config.iterationTimeout ?? 30000;
    let lastErrorMessage = "";

    while (iterations < maxIterations) {
      iterations++;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), iterationTimeout);

      try {
        const requestBody: RequestBody = {
          model: this.config.model,
          messages,
          tools: [toolSchema],
          tool_choice: "auto",
        };

        if (this.config.memoryTemperature !== false) {
          requestBody.temperature = this.config.memoryTemperature ?? 0.3;
        }

        if (this.config.extraParams) {
          applySafeExtraParams(requestBody, this.config.extraParams);
        }

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };

        if (this.config.apiKey) {
          headers.Authorization = `Bearer ${this.config.apiKey}`;
        }

        const response = await fetch(`${this.config.apiUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errorText = await response.text().catch(() => response.statusText);
          log("OpenAI Chat Completion API error", {
            provider: this.getProviderName(),
            model: this.config.model,
            status: response.status,
            error: errorText,
            iteration: iterations,
          });

          let errorMessage = `API error: ${response.status} - ${errorText}`;

          if (
            response.status === 400 &&
            errorText.includes("unsupported_value") &&
            errorText.includes("temperature")
          ) {
            errorMessage =
              'Your model does not support the temperature parameter. Add "memoryTemperature": false to your config file to disable it.';
          }

          return {
            success: false,
            error: errorMessage,
            iterations,
          };
        }

        const data: unknown = await response.json();

        if (isErrorResponseBody(data)) {
          log("API returned error in response body", {
            provider: this.getProviderName(),
            model: this.config.model,
            status: data.status,
            msg: data.msg,
          });
          return {
            success: false,
            error: `API error: ${data.status} - ${data.msg}`,
            iterations,
          };
        }

        if (!hasNonEmptyChoices(data)) {
          const choices =
            typeof data === "object" && data !== null
              ? (data as { choices?: unknown }).choices
              : undefined;

          log("Invalid API response format", {
            provider: this.getProviderName(),
            model: this.config.model,
            response: JSON.stringify(data).slice(0, 1000),
            hasChoices: Array.isArray(choices),
            choicesLength: Array.isArray(choices) ? choices.length : undefined,
          });
          return {
            success: false,
            error: "Invalid API response format",
            iterations,
          };
        }

        const choice = data.choices[0];
        if (!choice) {
          return {
            success: false,
            error: "Invalid API response format",
            iterations,
          };
        }

        const assistantSequence = this.aiSessionManager.getLastSequence(session.id) + 1;
        const assistantMsg: AssistantSessionMessage = {
          aiSessionId: session.id,
          sequence: assistantSequence,
          role: "assistant",
          content: choice.message.content ?? "",
        };

        if (choice.message.tool_calls) {
          assistantMsg.toolCalls = choice.message.tool_calls;
        }

        this.aiSessionManager.addMessage(assistantMsg);
        messages.push({
          role: "assistant",
          content: choice.message.content ?? null,
          tool_calls: choice.message.tool_calls,
        });

        if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
          for (const toolCall of choice.message.tool_calls) {
            const toolCallId = toolCall.id;

            if (toolCall.function.name === toolSchema.function.name) {
              try {
                const parsed = (() => {
                  const raw = toolCall.function.arguments;
                  if (typeof raw !== "string") {
                    return JSON.parse(JSON.stringify(raw));
                  }
                  try {
                    return JSON.parse(raw);
                  } catch (e1) {
                    const fixed = extractFirstJSON(raw);
                    if (fixed) {
                      try {
                        return JSON.parse(fixed);
                      } catch {
                        const repaired = repairInnerQuotes(fixed);
                        if (repaired !== fixed) {
                          try {
                            return JSON.parse(repaired);
                          } catch {}
                        }
                      }
                    }
                    throw e1;
                  }
                })();
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
                lastErrorMessage = errorMessage;
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
        const retryPrompt = lastErrorMessage
          ? `Your previous attempt failed. Error: ${lastErrorMessage}. Please fix the JSON in your tool call arguments and try again. Output ONLY valid JSON, no extra text outside the JSON structure.`
          : "Please use the tool to extract and save the data as instructed.";

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
            error: `API request timeout (${iterationTimeout}ms)`,
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
      error: `Max iterations (${maxIterations}) reached without tool call`,
      iterations,
    };
  }
}
