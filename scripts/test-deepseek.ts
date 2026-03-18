import { DeepSeekProvider } from "../src/services/ai/providers/deepseek.js";
import type { ChatCompletionTool } from "../src/services/ai/tools/tool-schema.js";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("Error: DEEPSEEK_API_KEY is not set.");
  process.exit(1);
}

const model = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
const apiUrl = process.env.DEEPSEEK_API_URL;

class FakeSessionManager {
  private readonly session = { id: "test-session-1" };
  private readonly messages: any[] = [];

  getSession(): any {
    return null;
  }
  createSession(): any {
    return this.session;
  }
  getMessages(): any[] {
    return this.messages;
  }
  getLastSequence(): number {
    return this.messages.length - 1;
  }
  addMessage(message: any): void {
    this.messages.push(message);
  }
}

const echoTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "echo_greeting",
    description: "Return a greeting message",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The greeting message to return",
        },
      },
      required: ["message"],
    },
  },
};

const config: Record<string, unknown> = {
  model,
  apiKey,
  ...(apiUrl ? { apiUrl } : {}),
  maxIterations: 3,
};

const provider = new DeepSeekProvider(config as any, new FakeSessionManager() as any);

console.log(`Provider : ${provider.getProviderName()}`);
console.log(`Model    : ${model}`);
console.log(`API URL  : ${apiUrl ?? "https://api.deepseek.com"}${apiUrl ? "" : " (default)"}`);
console.log("---");
console.log("Calling DeepSeek API...\n");

const systemPrompt =
  "You are a helpful assistant. When asked to greet, call the echo_greeting tool.";
const userPrompt =
  "Please greet me by calling the echo_greeting tool with message 'Hello from DeepSeek!'";

const result = await provider.executeToolCall(
  systemPrompt,
  userPrompt,
  echoTool,
  "integration-test"
);

if (result.success) {
  console.log("SUCCESS");
  console.log(`Iterations : ${result.iterations}`);
  console.log(`Result     :`, JSON.stringify((result as any).data, null, 2));
} else {
  console.error("FAILED");
  console.error(`Error      : ${result.error}`);
  console.error(`Iterations : ${result.iterations}`);
  process.exit(1);
}
