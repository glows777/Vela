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
import { registerToolSearchTool } from "./tools/tool-search";

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

registerToolSearchTool(toolRegistry);

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

const allCount = toolRegistry.getAllTools().length;
const activeTools = toolRegistry.getActiveTools();
const estimate = toolRegistry.countTokenEstimate();

console.log(`\n=== 工具统计 ===`);
console.log(`  全部工具: ${allCount} 个`);
console.log(`  活跃工具: ${activeTools.length} 个（非延迟）`);
console.log(`  延迟工具: ${allCount - activeTools.length} 个`);
console.log(
  `  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟)`,
);

const deferredSummary = toolRegistry.getDeferredToolSummary();

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

    const systemPrompt = `You are Vela, a helpful agent that can call tool.
      You have serval built-in tools and mcp tools to use.
      When the tools you need don't list in your tool call list, you can use tool_search tool to search it.
      Answer should be clean and direct.${deferredSummary}
      `;

    await agentLoop({
      model,
      systemPrompt,
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
