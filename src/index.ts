import {
  Client,
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client";
import { createOpenAI } from "@ai-sdk/openai";
import { type ModelMessage } from "ai";
import { createInterface } from "node:readline";
import { allTools } from "./tools";
import { agentLoop, type BudgetState } from "./agent";
import { ToolRegistry } from "./tools/register";

const model = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  baseURL: process.env.OPENAI_API_BASE_URL,
}).chat(process.env.OPENAI_API_MODEL_NAME!);

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});
let rlClosed = false;
rl.on("close", () => {
  rlClosed = true;
});

const messages: ModelMessage[] = [];
const budget: BudgetState = { used: 0, limit: 15000 * 10 };
const toolRegistry = new ToolRegistry();
toolRegistry.register(...allTools);

const MCP_INITIAL_RETRY_DELAY_MS = 30_000;
const MCP_MAX_RETRY_DELAY_MS = 5 * 60_000;

let mcpConnection: Promise<boolean> | null = null;
let mcpFailureCount = 0;
let nextMCPRetryAt = 0;

async function connectMCP() {
  if (mcpConnection) {
    await mcpConnection;
    return;
  }

  if (Date.now() < nextMCPRetryAt) {
    return;
  }

  const connection = connectGitHubMCP();
  mcpConnection = connection;
  const connected = await connection;
  if (connected) {
    mcpFailureCount = 0;
    nextMCPRetryAt = 0;
  } else {
    if (mcpConnection === connection) {
      mcpConnection = null;
    }
    scheduleMCPRetry();
  }
}

async function connectGitHubMCP(): Promise<boolean> {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

  if (!githubToken) {
    console.log("\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，使用 Mock MCP");
    return true;
  }

  console.log("\n连接 GitHub MCP Server...");
  try {
    const transport = new StdioClientTransport({
      command: "bunx",
      args: ["@modelcontextprotocol/server-github"],
      env: {
        ...getDefaultEnvironment(),
        GITHUB_PERSONAL_ACCESS_TOKEN: githubToken,
      },
    });
    const client = new Client({ name: "Vela-agent", version: "1.0.0" });
    const tools = await toolRegistry.registerMCPServer(
      "github",
      client,
      transport,
    );
    console.log(`  已注册 ${tools.length} 个 MCP 工具`);
    return true;
  } catch (err) {
    console.log(`  MCP 连接失败: ${err instanceof Error ? err.message : err}`);
    console.log(err);
    return false;
  }
}

function scheduleMCPRetry() {
  mcpFailureCount++;
  const delay = Math.min(
    MCP_INITIAL_RETRY_DELAY_MS * 2 ** (mcpFailureCount - 1),
    MCP_MAX_RETRY_DELAY_MS,
  );
  nextMCPRetryAt = Date.now() + delay;
  console.log(`  MCP 将在 ${Math.round(delay / 1000)} 秒后再次尝试连接`);
}

await connectMCP();

console.log(
  `has registered tool count: ${toolRegistry.getAllTools().length}：`,
);
for (const tool of toolRegistry.getAllTools()) {
  const isMCP = tool.name.startsWith("mcp__");
  const flags = [
    tool.isConcurrencySafe ? "concurrency" : "parrecel",
    tool.isReadOnly ? "read only" : "read and write",
    isMCP ? "MCP" : "built in tool",
  ].join(", ");
  console.log(`  - ${tool.name}（${flags}）`);
}

const ask = () => {
  if (rlClosed) {
    return;
  }

  rl.question("You: ", async (input) => {
    await connectMCP();
    const trimmed = input.trim();
    if (!trimmed || trimmed === "exit") {
      console.log("Bye!");
      await toolRegistry.closeAllMCP();
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

if (rlClosed) {
  await toolRegistry.closeAllMCP();
} else {
  ask();
}
