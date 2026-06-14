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
import { ToolRegistry } from "./tools/registry";
import { registerToolSearchTool } from "./tools/tool-search";
import { SessionStore } from "./session";
import { PromptPipeline, type PromptContext } from "./prompt/pipelins";
import { coreRules, deferredTools, sessionContext, toolGuide } from "./prompt";

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

let messages: ModelMessage[] = [];
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

// await connectMCP();

const isContinue = process.argv.includes("--continue");
const store = new SessionStore("default");

if (isContinue && (await store.exists())) {
  messages = await store.load();
  console.log(`[Session] 恢复会话，${messages.length} 条历史消息`);
} else {
  console.log(`[Session] 新会话`);
}

const builder = new PromptPipeline()
  .pipe("coreRules", coreRules())
  .pipe("toolGuide", toolGuide())
  .pipe("deferredTools", deferredTools())
  .pipe("sessionContext", sessionContext());

const promptCtx: PromptContext = {
  toolCount: toolRegistry.getAllTools().length,
  deferredToolSummary: toolRegistry.getDeferredToolSummary(),
  sessionMessageCount: messages.length,
  sessionId: "default",
};

const SYSTEM = builder.build(promptCtx);
builder.debug(promptCtx); // 显示各模块状态

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

    const userMessage: ModelMessage = { role: "user", content: trimmed };
    store.append(userMessage);
    messages.push(userMessage);

    const beforeLen = messages.length;
    await agentLoop({
      model,
      systemPrompt: SYSTEM,
      toolRegistry,
      messages,
      budget,
    });

    console.log("\n");
    // 持久化本轮新增的消息（agent loop 会往 messages 里 push assistant/tool 消息）
    const newMessages = messages.slice(beforeLen);
    store.appendAll(newMessages);

    ask();
  });
};

if (rlClosed) {
  await toolRegistry.closeAllMCP();
} else {
  ask();
}
