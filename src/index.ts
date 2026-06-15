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
import { estimateTokens, microcompact, summarize } from "./context/compressor";

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

injectFakeHistory(messages);

let summary = "";
// ── 压缩演示 ──
const beforeTokens = estimateTokens(messages);
console.log(`\n[压缩前] ${messages.length} 条消息, ~${beforeTokens} tokens`);

// Layer 1: Microcompact
const mc = microcompact(messages);
messages = mc.messages;
const afterMCTokens = estimateTokens(messages);
console.log(
  `[Layer 1: Microcompact] 清理了 ${mc.cleared} 个工具结果, ~${afterMCTokens} tokens`,
);

// Layer 2: LLM Summarization
const compResult = await summarize(model, messages, summary);
messages = compResult.messages;
summary = compResult.summary;
const afterSumTokens = estimateTokens(messages);
if (compResult.compressedCount > 0) {
  console.log(
    `[Layer 2: Summarization] 压缩了 ${compResult.compressedCount} 条消息, ~${afterSumTokens} tokens`,
  );
  console.log(`[摘要预览] ${summary.slice(0, 150)}...`);
} else {
  console.log(`[Layer 2: Summarization] 未触发（消息量不够）`);
}

console.log(
  `[压缩后] ${messages.length} 条消息, ~${afterSumTokens} tokens (节省 ${beforeTokens - afterSumTokens} tokens)\n`,
);

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

function injectFakeHistory(messages: ModelMessage[]) {
  const fakeHistory: ModelMessage[] = [
    { role: "user", content: "帮我看看当前目录有什么文件" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call" as const,
          toolCallId: "fake-1",
          toolName: "list_directory",
          input: { path: "." },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result" as const,
          toolCallId: "fake-1",
          toolName: "list_directory",
          output:
            "[FILE] .env\n[DIR] node_modules\n[FILE] package.json\n[FILE] sample-data.txt\n[DIR] src\n[FILE] tsconfig.json",
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "text" as const,
          text: "当前目录有以下文件：.env, package.json, sample-data.txt, tsconfig.json，以及 src 和 node_modules 两个目录。",
        },
      ],
    },
    { role: "user", content: "读一下 package.json" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call" as const,
          toolCallId: "fake-2",
          toolName: "read_file",
          input: { path: "package.json" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result" as const,
          toolCallId: "fake-2",
          toolName: "read_file",
          output:
            '{\n  "name": "super-agent-08-compaction",\n  "version": "0.8.0",\n  "type": "module",\n  "scripts": { "start": "tsx src/index.ts" },\n  "dependencies": { "ai": "5.0.98", "@ai-sdk/openai": "2.0.44" }\n}',
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "text" as const,
          text: "package.json 的内容：项目名 super-agent-08-compaction，版本 0.8.0，依赖 ai 和 @ai-sdk/openai。",
        },
      ],
    },
    { role: "user", content: "读一下 sample-data.txt" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call" as const,
          toolCallId: "fake-3",
          toolName: "read_file",
          input: { path: "sample-data.txt" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result" as const,
          toolCallId: "fake-3",
          toolName: "read_file",
          output:
            'Super Agent 工具系统设计文档\n=============================\n\n一、工具注册机制\n每个工具通过 ToolRegistry 统一注册，提供名称、描述、参数 Schema 和执行函数。\n\n二、结果截断策略\nHead/Tail 60/40 分割，保留文件头部和尾部的关键信息。\n\n三、并发控制\n读写锁模式：只读工具共享锁，读写工具独占锁。\n\n四、最佳实践\n1. 工具描述要写"什么时候不该用"比"能干什么"更有价值\n2. 参数描述要具体——"必须是绝对路径"能防一大类错误\n3. 错误信息要对模型友好——模型需要理解为什么失败才能换策略\n4. 结果格式要结构化——JSON 比自然语言更容易被模型准确解析',
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "text" as const,
          text: "sample-data.txt 是一份工具系统设计文档，包含四个部分：工具注册机制、结果截断策略、并发控制和最佳实践。",
        },
      ],
    },
    { role: "user", content: "帮我搜索一下 src 目录里有哪些 export" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call" as const,
          toolCallId: "fake-4",
          toolName: "grep",
          input: { pattern: "export", path: "src" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result" as const,
          toolCallId: "fake-4",
          toolName: "grep",
          output:
            "src/tools.ts:1: export const weatherTool\nsrc/tools.ts:20: export const calculatorTool\nsrc/tools.ts:40: export const readFileTool\nsrc/tool-registry.ts:4: export interface ToolDefinition\nsrc/tool-registry.ts:18: export class ToolRegistry\nsrc/agent-loop.ts:7: export async function agentLoop\nsrc/session-store.ts:8: export class SessionStore\nsrc/prompt-builder.ts:12: export class PromptBuilder\nsrc/context-compressor.ts:30: export function microcompact\nsrc/context-compressor.ts:80: export async function summarize",
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "text" as const,
          text: "src 目录里的主要导出：tools.ts 导出了各种工具定义，tool-registry.ts 导出了 ToolRegistry 类，agent-loop.ts 导出了 agentLoop 函数，还有 SessionStore、PromptBuilder、microcompact 和 summarize 等。",
        },
      ],
    },
  ];
  messages.push(...fakeHistory);
}
