import { createOpenAI } from "@ai-sdk/openai";
import { stepCountIs, streamText, type ModelMessage } from "ai";
import { createInterface } from "readline";
import { allTools, calculatorTool, weatherTool } from "./tools";
import { agentLoop, type BudgetState } from "./agent";
import { createMockModel } from "./mock";
import { ToolRegistry } from "./tools/register";

const model = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  baseURL: process.env.OPENAI_API_BASE_URL,
}).chat(process.env.OPENAI_API_MODEL_NAME!);

// const model = createMockModel();

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

const messages: ModelMessage[] = [];
const budget: BudgetState = { used: 0, limit: 15000 };
const toolRegistry = new ToolRegistry();
toolRegistry.register(...allTools);

console.log(
  `has registered tool count: ${toolRegistry.getAllTools().length}：`,
);
for (const tool of toolRegistry.getAllTools()) {
  const flags = [
    tool.isConcurrencySafe ? "concurrency" : "parrecel",
    tool.isReadOnly ? "read only" : "read and write",
  ].join(", ");
  console.log(`  - ${tool.name}（${flags}）`);
}

const ask = () => {
  rl.question("You: ", async (input) => {
    const trimmed = input.trim();
    if (!trimmed || trimmed === "exit") {
      console.log("Bye!");
      rl.close();
      return;
    }

    messages.push({ role: "user", content: trimmed });

    await agentLoop({
      model,
      systemPrompt:
        "You are Vela, an assistant that can call tools to answer user questions.",
      toolRegistry,
      messages,
      budget,
    });

    console.log("\n");
    ask();
  });
};

ask();
