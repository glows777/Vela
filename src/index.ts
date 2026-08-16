import {
  Client,
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client";
import { createOpenAI } from "@ai-sdk/openai";
import { type ModelMessage } from "ai";
import { createInterface } from "node:readline";
import { allTools } from "./tools";
import { agentLoop } from "./agent";
import { ToolRegistry } from "./tools/registry";
import { registerToolSearchTool } from "./tools/tool-search";
import { SessionStore } from "./session";
import { PromptPipeline, type PromptContext } from "./prompt/pipelins";
import { coreRules, deferredTools, sessionContext, toolGuide } from "./prompt";
import {
  microcompact,
  MICROCOMPACT_TOKEN_THRESHOLD,
  summarize,
  SUMMARY_TOKEN_THRESHOLD,
} from "./context/compressor";
import { createMockModel, setCacheEnabled } from "./mock";
import { applyDefense, estimateMessageTokens, TokenTracker } from "./context/defense";
import { buildContextSnapshot, renderContextView, renderUsageView } from "./context/view";
import { UsageTracker } from "./usage/tracker";
import { textToolResultOutput } from "./context/tool-result-output";

const model = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  baseURL: process.env.OPENAI_API_BASE_URL,
}).chat(process.env.OPENAI_API_MODEL_NAME!);
//
// const model = createMockModel();

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});
let rlClosed = false;
rl.on("close", () => {
  rlClosed = true;
});

let messages: ModelMessage[] = [];
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
const tokenTracker = new TokenTracker();
let summary = "";
const timestamps = new Map<ModelMessage, number>();
const usageTracker = new UsageTracker('.usage/today.jsonl');

if (isContinue && (await store.exists())) {
  const state = await store.loadState();
  messages.push(...state.messages);
  for (const [message, timestamp] of state.timestamps) {
    timestamps.set(message, timestamp);
  }
  summary = state.summary;
  tokenTracker.setEstimatedTokens(estimateMessageTokens(messages));
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

function messagesChanged(
  before: ModelMessage[],
  after: ModelMessage[],
): boolean {
  return (
    before.length !== after.length ||
    before.some((message, index) => message !== after[index])
  );
}

function replaceMessagesInPlace(
  target: ModelMessage[],
  replacement: ModelMessage[],
): void {
  const previous = target.slice();
  const knownTimestamps = new Map(timestamps);
  const fallbackTimestamp = Date.now();

  target.splice(0, target.length, ...replacement);
  timestamps.clear();

  replacement.forEach((message, index) => {
    const timestamp =
      knownTimestamps.get(message) ??
      (previous[index] ? knownTimestamps.get(previous[index]!) : undefined) ??
      fallbackTimestamp;
    timestamps.set(message, timestamp);
  });
}

function ensureMessageTimestamps(history: ModelMessage[]): void {
  const liveMessages = new Set(history);
  const now = Date.now();

  for (const message of history) {
    if (!timestamps.has(message)) {
      timestamps.set(message, now);
    }
  }

  for (const message of timestamps.keys()) {
    if (!liveMessages.has(message)) {
      timestamps.delete(message);
    }
  }
}

function currentContextTokens(history: ModelMessage[]): number {
  return Math.max(tokenTracker.estimatedTokens, estimateMessageTokens(history));
}

async function prepareContextForModel(history: ModelMessage[]): Promise<void> {
  ensureMessageTimestamps(history);

  const beforeDefense = history.slice();
  const defense = applyDefense(history, timestamps);
  if (messagesChanged(beforeDefense, defense.messages)) {
    tokenTracker.replaceMessages(beforeDefense, defense.messages);
    replaceMessagesInPlace(history, defense.messages);
  }

  if (
    defense.truncated > 0 ||
    defense.compacted > 0 ||
    defense.softPruned > 0 ||
    defense.hardPruned > 0
  ) {
    console.log(
      `  [Defense] truncated=${defense.truncated}, compacted=${defense.compacted}, softPruned=${defense.softPruned}, hardPruned=${defense.hardPruned}`,
    );
  }

  let tokenEstimate = currentContextTokens(history);
  if (tokenEstimate >= MICROCOMPACT_TOKEN_THRESHOLD) {
    const beforeMicrocompact = history.slice();
    const compacted = microcompact(history);
    if (
      compacted.cleared > 0 &&
      messagesChanged(beforeMicrocompact, compacted.messages)
    ) {
      tokenTracker.replaceMessages(beforeMicrocompact, compacted.messages);
      replaceMessagesInPlace(history, compacted.messages);
      tokenEstimate = currentContextTokens(history);
      console.log(
        `  [Microcompact] 清理了 ${compacted.cleared} 个工具结果，~${tokenEstimate} tokens`,
      );
    }
  }

  if (tokenEstimate >= SUMMARY_TOKEN_THRESHOLD) {
    const beforeSummary = history.slice();
    const compacted = await summarize(
      model,
      history,
      summary,
      tokenEstimate,
    );
    if (
      compacted.compressedCount > 0 &&
      messagesChanged(beforeSummary, compacted.messages)
    ) {
      tokenTracker.replaceMessages(beforeSummary, compacted.messages);
      replaceMessagesInPlace(history, compacted.messages);
      summary = compacted.summary;
      console.log(
        `  [Summarization] 压缩了 ${compacted.compressedCount} 条消息，~${currentContextTokens(history)} tokens`,
      );
    }
  }
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

    if (handleQuickTrigger(trimmed)) {
      ask();
      return;
    }

    const userMsg: ModelMessage = { role: 'user', content: trimmed };
    messages.push(userMsg);
    tokenTracker.addMessage(userMsg);
    timestamps.set(userMsg, Date.now());

    try {
      await agentLoop({
        model,
        systemPrompt: SYSTEM,
        toolRegistry,
        messages,
        tokenTracker,
        usageTracker,
        prepareContext: prepareContextForModel,
      });
    } finally {
      ensureMessageTimestamps(messages);
      await store.replace(messages, timestamps, summary);
    }

    const status = tokenTracker.status;
    console.log(`  [Token] ~${status.tokens} tokens (${status.percent}%)`);
    ask();
  });
};

if (rlClosed) {
  await toolRegistry.closeAllMCP();
} else {
  ask();
}


function handleQuickTrigger(cmd: string): boolean {
    const now = Date.now();

    if (cmd === '模拟长对话' || cmd === 'sim') {
      console.log('\n[模拟] 注入 20 条历史消息（含大量工具结果）...');
      for (let i = 0; i < 5; i++) {
        const age = (20 - i * 4) * 60 * 1000;
        const timestamp = now - age;
        const userMessage: ModelMessage = {
          role: 'user',
          content: `第 ${i + 1} 轮：帮我读文件 file-${i}.ts`,
        };
        messages.push(userMessage);
        timestamps.set(userMessage, timestamp);
        const toolCallMessage: ModelMessage = {
          role: 'assistant',
          content: [{ type: 'tool-call' as const, toolCallId: `sim-${i}`, toolName: 'read_file', input: { path: `file-${i}.ts` } }],
        };
        messages.push(toolCallMessage);
        timestamps.set(toolCallMessage, timestamp);
        const bigContent = `// file-${i}.ts\n` + 'export function handler() {\n  // ...\n}\n'.repeat(200);
        const toolResultMessage: ModelMessage = {
          role: 'tool',
          content: [{ type: 'tool-result' as const, toolCallId: `sim-${i}`, toolName: 'read_file', output: textToolResultOutput(bigContent) }],
        };
        messages.push(toolResultMessage);
        timestamps.set(toolResultMessage, timestamp);
        const assistantMessage: ModelMessage = {
          role: 'assistant',
          content: [{ type: 'text' as const, text: `文件 file-${i}.ts 的内容已读取。` }],
        };
        messages.push(assistantMessage);
        timestamps.set(assistantMessage, timestamp);
      }
      const tokens = estimateMessageTokens(messages);
      console.log(`[模拟完成] ${messages.length} 条消息, ~${tokens} tokens\n`);
      return true;
    }

    if (cmd === '执行防线' || cmd === 'defend') {
      console.log('\n--- 执行三层防线 ---');
      const before = estimateMessageTokens(messages);
      const def = applyDefense(messages, timestamps);
      messages = def.messages;
      console.log(`  [Layer 2] 截断: ${def.truncated} 条, 预算清理: ${def.compacted} 条`);
      console.log(`  [Layer 3] 软修剪: ${def.softPruned}, 硬清除: ${def.hardPruned}`);
      console.log(`  [结果] ~${before} → ~${def.tokenEstimate} tokens (节省 ${before - def.tokenEstimate})\n`);
      return true;
    }

    if (cmd === '查看状态' || cmd === 'status') {
      const tokens = estimateMessageTokens(messages);
      const toolMsgs = messages.filter(m => m.role === 'tool').length;
      console.log(`\n[状态] ${messages.length} 条消息 (${toolMsgs} 条工具结果), ~${tokens} tokens\n`);
      return true;
    }

    // /context: 终端可视化的 context 占用，参考 Claude Code 的 /context
    if (cmd === '/context' || cmd === 'context') {
      const snapshot = buildContextSnapshot({
        modelName: process.env.DASHSCOPE_API_KEY ? 'Qwen Plus' : 'Mock Model (开发用)',
        modelId: process.env.DASHSCOPE_API_KEY ? 'qwen3-6-plus' : 'mock-model',
        windowTokens: 1_000_000,
        systemPromptChars: SYSTEM.length,
        toolDescriptionChars: toolRegistry.getActiveTools().reduce((a, t) => a + t.name.length + (t.description?.length || 0) + JSON.stringify(t.inputSchema || {}).length, 0),
        memoryChars: 0,
        skillsChars: 0,
        messages,
      });
      console.log(renderContextView(snapshot));
      return true;
    }

    if (cmd === '/usage' || cmd === 'usage') {
      console.log(renderUsageView(usageTracker));
      return true;
    }

    if (cmd === '/cache off' || cmd === 'cache off') {
      setCacheEnabled(false);
      console.log('\n  \x1b[38;5;220m⚠ 已关闭 cache 模拟\x1b[0m  接下来每次请求都按 cache miss 计算\n');
      return true;
    }
    if (cmd === '/cache on' || cmd === 'cache on') {
      setCacheEnabled(true);
      console.log('\n  \x1b[38;5;36m✓ 已开启 cache 模拟\x1b[0m\n');
      return true;
    }

    return false;
  }
