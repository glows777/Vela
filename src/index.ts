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
import { microcompact, summarize } from "./context/compressor";
import { createMockModel } from "./mock";
import { textToolResultOutput } from "./context/tool-result-output";
import { applyDefense, estimateMessageTokens, TokenTracker } from "./context/defense";

// const model = createOpenAI({
//   apiKey: process.env.OPENAI_API_KEY!,
//   baseURL: process.env.OPENAI_API_BASE_URL,
// }).chat(process.env.OPENAI_API_MODEL_NAME!);
//
const model = createMockModel();

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
  // if (mcpConnection) {
  //   await mcpConnection;
  //   return;
  // }
  // if (Date.now() < nextMCPRetryAt) {
  //   return;
  // }
  // const connection = connectGitHubMCP();
  // mcpConnection = connection;
  // const connected = await connection;
  // if (connected) {
  //   mcpFailureCount = 0;
  //   nextMCPRetryAt = 0;
  // } else {
  //   if (mcpConnection === connection) {
  //     mcpConnection = null;
  //   }
  //   scheduleMCPRetry();
  // }
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

const isContinue = process.argv.includes("--continue");
const store = new SessionStore("default");
const tracker = new TokenTracker();

if (isContinue && (await store.exists())) {
  messages = await store.load();
  console.log(`[Session] 恢复会话，${messages.length} 条历史消息`);
} else {
  console.log(`[Session] 新会话`);
}

const timestamps = new Map<number, number>();

// Inject fake history with varied ages
injectFakeHistory(messages, timestamps);
console.log(
  `\n[Session] 新会话（已注入 ${messages.length} 条模拟历史，时间跨度 12 分钟）`,
);

// Apply three-layer defense
const beforeTokens = estimateMessageTokens(messages);
console.log(`\n=== 三层即时防线 ===`);
console.log(`[防线前] ${messages.length} 条消息, ~${beforeTokens} tokens`);

const defense = applyDefense(messages, timestamps);
messages = defense.messages;
console.log(`[Layer 2: 截断] ${defense.truncated} 个超长结果被截断`);
console.log(
  `[Layer 3: TTL] ${defense.softPruned} 个软修剪, ${defense.hardPruned} 个硬清除`,
);
console.log(
  `[防线后] ${messages.length} 条消息, ~${defense.tokenEstimate} tokens (节省 ${beforeTokens - defense.tokenEstimate})`,
);
console.log(`====================\n`);

// Clear injected history for chat — defense demo is done,
// start fresh so mock model works properly
messages = [];
timestamps.clear();

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

    const userMsg: ModelMessage = { role: 'user', content: trimmed };
    messages.push(userMsg);
    tracker.addMessage(userMsg);
    timestamps.set(messages.length - 1, Date.now());
    store.append(userMsg);

    // Apply all three defense layers before every model turn.
    const turnDefense = applyDefense(messages, timestamps);
    tracker.replaceMessages(messages, turnDefense.messages);
    messages = turnDefense.messages;

    const beforeLen = messages.length;
    await agentLoop({
      model,
      systemPrompt: SYSTEM,
      toolRegistry,
      messages,
      tracker
    });

    const newMessages = messages.slice(beforeLen);
    const now = Date.now();
    for (let i = beforeLen; i < messages.length; i++) {
      timestamps.set(i, now);
    }
    store.appendAll(newMessages);

    const status = tracker.status;
    console.log(`  [Token] ~${status.tokens} tokens (${status.percent}%)`);

    ask();
  });
};

if (rlClosed) {
  await toolRegistry.closeAllMCP();
} else {
  ask();
}

/** Inject fake history with timestamps to demo TTL pruning. */
function injectFakeHistory(messages: ModelMessage[], timestamps: Map<number, number>) {
  const now = Date.now();
  const fakeHistory: Array<{ msg: ModelMessage; ageMs: number }> = [
    // 12 minutes ago — will be hard pruned
    { ageMs: 12 * 60 * 1000, msg: { role: 'user', content: '帮我看看 package.json' } },
    { ageMs: 12 * 60 * 1000, msg: { role: 'assistant', content: [{ type: 'tool-call' as const, toolCallId: 'old-1', toolName: 'read_file', input: { path: 'package.json' } }] } },
    { ageMs: 12 * 60 * 1000, msg: { role: 'tool', content: [{ type: 'tool-result' as const, toolCallId: 'old-1', toolName: 'read_file', output: textToolResultOutput('{\n  "name": "super-agent-09",\n  "version": "0.9.0",\n  "type": "module",\n  "scripts": { "start": "tsx src/index.ts" },\n  "dependencies": {\n    "ai": "5.0.98",\n    "@ai-sdk/openai": "2.0.44",\n    "zod": "3.25.76"\n  }\n}') }] } },
    { ageMs: 12 * 60 * 1000, msg: { role: 'assistant', content: [{ type: 'text' as const, text: 'package.json：项目名 super-agent-09，依赖 ai 和 @ai-sdk/openai。' }] } },

    // 7 minutes ago — will be soft pruned
    { ageMs: 7 * 60 * 1000, msg: { role: 'user', content: '搜索 src 目录里的 export' } },
    { ageMs: 7 * 60 * 1000, msg: { role: 'assistant', content: [{ type: 'tool-call' as const, toolCallId: 'mid-1', toolName: 'grep', input: { pattern: 'export', path: 'src' } }] } },
    { ageMs: 7 * 60 * 1000, msg: { role: 'tool', content: [{ type: 'tool-result' as const, toolCallId: 'mid-1', toolName: 'grep', output: textToolResultOutput('src/tools.ts:1: export const weatherTool = ...\nsrc/tools.ts:20: export const calculatorTool = ...\nsrc/tools.ts:40: export const readFileTool = ...\nsrc/tools.ts:60: export const writeFileTool = ...\nsrc/tools.ts:80: export const listDirectoryTool = ...\nsrc/tool-registry.ts:4: export interface ToolDefinition { ... }\nsrc/tool-registry.ts:18: export class ToolRegistry { ... }\nsrc/agent-loop.ts:7: export async function agentLoop(...) { ... }\nsrc/session-store.ts:8: export class SessionStore { ... }\nsrc/prompt-builder.ts:12: export class PromptBuilder { ... }\nsrc/context-defense.ts:5: export class TokenTracker { ... }\nsrc/context-defense.ts:50: export function estimateMessageTokens(...) { ... }\nsrc/context-defense.ts:70: export function truncateToolResults(...) { ... }\nsrc/context-defense.ts:110: export function ttlPrune(...) { ... }') }] } },
    { ageMs: 7 * 60 * 1000, msg: { role: 'assistant', content: [{ type: 'text' as const, text: 'src 目录里的主要导出：tools.ts 定义了各种工具，tool-registry.ts 导出 ToolRegistry 类，context-defense.ts 导出了 TokenTracker、truncateToolResults、ttlPrune 等。' }] } },

    // 1 minute ago — will NOT be pruned
    { ageMs: 1 * 60 * 1000, msg: { role: 'user', content: '读一下 sample-data.txt' } },
    { ageMs: 1 * 60 * 1000, msg: { role: 'assistant', content: [{ type: 'tool-call' as const, toolCallId: 'new-1', toolName: 'read_file', input: { path: 'sample-data.txt' } }] } },
    { ageMs: 1 * 60 * 1000, msg: { role: 'tool', content: [{ type: 'tool-result' as const, toolCallId: 'new-1', toolName: 'read_file', output: textToolResultOutput('Super Agent 工具系统设计文档\n=============================\n\n一、工具注册机制\n每个工具通过 ToolRegistry 统一注册。\n\n二、结果截断策略\nHead/Tail 60/40 分割。\n\n三、并发控制\n读写锁模式。\n\n四、最佳实践\n1. 工具描述要写"什么时候不该用"\n2. 参数描述要具体\n3. 错误信息要对模型友好\n4. 结果格式要结构化') }] } },
    { ageMs: 1 * 60 * 1000, msg: { role: 'assistant', content: [{ type: 'text' as const, text: 'sample-data.txt 是工具系统设计文档，包含注册机制、截断策略、并发控制和最佳实践四个部分。' }] } },
  ];

  for (let i = 0; i < fakeHistory.length; i++) {
    const { msg, ageMs } = fakeHistory[i]!;
    messages.push(msg);
    timestamps.set(messages.length - 1, now - ageMs);
  }
}
