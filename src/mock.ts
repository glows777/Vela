/**
 * Mock Model v0.4 — Tool System
 *
 * 在 v0.3 基础上新增：
 * - 文件操作工具支持（read_file, list_directory）
 * - "测试并发"：同时调用 3 个工具，验证并发执行
 * - "测试截断"：读取大文件，验证结果截断
 * - 多工具调用（parallel tool calls）
 */

import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";

let retryTestCount = 0;

const TEXT_RESPONSES = {
  default:
    '你好！我是 Super Agent v0.4.1，现在有 9 个内置工具了。试试"测试编辑"、"测试搜索"、"测试glob"、"测试bash"看看新功能。',
  greeting: "你好！我是 Super Agent v0.4.1，支持文件编辑、搜索、命令执行 :)",
} as const;

interface ToolCallIntent {
  toolName: string;
  args: Record<string, unknown>;
}

function extractUserText(prompt: any[]): string {
  const userMsgs = (prompt || []).filter((m: any) => m.role === "user");
  const last = userMsgs[userMsgs.length - 1];
  if (!last) return "";
  if (typeof last.content === "string") return last.content.toLowerCase();
  return (last.content || [])
    .map((c: any) => c.text || "")
    .join("")
    .toLowerCase();
}

function hasToolResults(prompt: any[]): boolean {
  const msgs = prompt || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "tool") return true;
    if (msgs[i].role === "user") return false;
  }
  return false;
}

function detectParallelIntent(text: string): ToolCallIntent[] | null {
  if (text.includes("测试并发") || text.includes("test parallel")) {
    return [
      { toolName: "get_weather", args: { city: "北京" } },
      { toolName: "get_weather", args: { city: "上海" } },
      { toolName: "list_directory", args: { path: "." } },
    ];
  }
  return null;
}

function detectToolIntent(prompt: any[]): ToolCallIntent | null {
  const text = extractUserText(prompt);

  if (text.includes("测试死循环")) {
    return { toolName: "get_weather", args: { city: "北京" } };
  }

  if (hasToolResults(prompt)) return null;

  if (text.includes("测试截断") || text.includes("test truncation")) {
    return { toolName: "read_file", args: { path: "sample-data.txt" } };
  }

  if (text.includes("测试编辑") || text.includes("test edit")) {
    return {
      toolName: "edit_file",
      args: {
        path: "sample-data.txt",
        old_string: "一、工具注册机制",
        new_string: "一、工具注册机制（已更新）",
      },
    };
  }

  if (text.includes("测试搜索") || text.includes("test grep")) {
    return { toolName: "grep", args: { pattern: "export", path: "src" } };
  }

  if (text.includes("测试glob") || text.includes("test glob")) {
    return { toolName: "glob", args: { pattern: "**/*.ts" } };
  }

  if (text.includes("测试bash") || text.includes("test bash")) {
    return {
      toolName: "bash",
      args: { command: 'echo "Hello from bash!" && date' },
    };
  }

  if (
    text.includes("目录") ||
    text.includes("文件列表") ||
    text.includes("ls")
  ) {
    return { toolName: "list_directory", args: { path: "." } };
  }

  if (
    (text.includes("搜") || text.includes("找") || text.includes("grep")) &&
    !text.includes("文件")
  ) {
    const keyword = text.replace(/.*(?:搜|找|grep)\s*/, "").trim() || "TODO";
    return { toolName: "grep", args: { pattern: keyword, path: "." } };
  }

  const fileMatch = text.match(/(\S+\.[\w]+)/);
  if (
    fileMatch &&
    (text.includes("读") ||
      text.includes("read") ||
      text.includes("看看") ||
      text.includes("查看") ||
      text.includes("打开") ||
      text.includes("文件") ||
      text.includes("file"))
  ) {
    return { toolName: "read_file", args: { path: fileMatch[1] } };
  }

  const weatherKeywords = ["天气", "weather", "温度", "热", "冷", "气温"];
  const hasWeatherIntent = weatherKeywords.some((kw) => text.includes(kw));
  const cities = text.match(/(北京|上海|深圳|广州|杭州|成都)/g);
  if (hasWeatherIntent && cities && cities.length > 0) {
    return { toolName: "get_weather", args: { city: cities[0] } };
  }

  const calcMatch = text.match(/(\d+)\s*[+\-*/加减乘除]\s*(\d+)/);
  if (calcMatch) {
    const op = text.match(/[+*/]|加|减|乘|除|-/)?.[0] || "+";
    const opMap: Record<string, string> = {
      加: "+",
      减: "-",
      乘: "*",
      除: "/",
    };
    const expression = `${calcMatch[1]} ${opMap[op] || op} ${calcMatch[2]}`;
    return { toolName: "calculator", args: { expression } };
  }

  return null;
}

function pickTextResponse(prompt: any[]): string {
  if (hasToolResults(prompt)) {
    const msgs = prompt || [];
    const toolMsgs = [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "tool") {
        toolMsgs.unshift(msgs[i]);
      } else if (msgs[i].role === "user") break;
    }

    const parts: string[] = [];
    for (const tm of toolMsgs) {
      const content = tm.content || [];
      for (const c of content) {
        const val = c.output?.value || c.output || c.result || "";
        parts.push(String(val));
      }
    }
    const combined = parts.join("\n");

    if (combined.includes("[DIR]") || combined.includes("[FILE]")) {
      return `当前目录的文件列表：\n${combined}`;
    }
    if (combined.includes("省略") || combined.includes("truncat")) {
      return `文件内容已读取（注意部分内容被截断了）：\n${combined}`;
    }
    if (combined.includes("°C") || combined.includes("天气")) {
      if (parts.length > 1) {
        return `查询到多个城市的天气：\n${parts.map((p) => `- ${p}`).join("\n")}`;
      }
      return `根据查询结果：${combined}`;
    }
    if (combined.includes("已写入")) {
      return `文件操作完成：${combined}`;
    }
    return `工具返回了以下信息：\n${combined}`;
  }

  const text = extractUserText(prompt);
  if (text.includes("你好") || text.includes("hello") || text.includes("hi"))
    return TEXT_RESPONSES.greeting;
  return TEXT_RESPONSES.default;
}

const USAGE: LanguageModelV3Usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

function createDelayedStream<T>(chunks: T[], delayMs = 30): ReadableStream<T> {
  return new ReadableStream({
    start(controller) {
      let i = 0;
      function next() {
        if (i < chunks.length) {
          controller.enqueue(chunks[i++]);
          setTimeout(next, delayMs);
        } else {
          controller.close();
        }
      }
      next();
    },
  });
}

function makeToolCallChunks(intents: ToolCallIntent[]): LanguageModelV3StreamPart[] {
  const chunks: LanguageModelV3StreamPart[] = [];
  for (const intent of intents) {
    const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const argsJson = JSON.stringify(intent.args);
    chunks.push(
      { type: "tool-input-start", id: callId, toolName: intent.toolName },
      { type: "tool-input-delta", id: callId, delta: argsJson },
      { type: "tool-input-end", id: callId },
      {
        type: "tool-call",
        toolCallId: callId,
        toolName: intent.toolName,
        input: argsJson,
      },
    );
  }
  chunks.push({
    type: "finish",
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: USAGE,
  });
  return chunks;
}

export function createMockModel(): LanguageModelV3 {
  return {
    specificationVersion: "v3" as const,
    provider: "mock",
    modelId: "mock-model-v0.4.1",

    get supportedUrls() {
      return Promise.resolve({});
    },

    async doGenerate({ prompt }: any) {
      const text = extractUserText(prompt);

      if (text.includes("测试重试") || text.includes("test retry")) {
        retryTestCount++;
        if (retryTestCount <= 2) {
          throw new Error("429 Too Many Requests - Rate limit exceeded");
        }
        retryTestCount = 0;
        return {
          content: [{ type: "text" as const, text: "重试成功！" }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      }

      const parallelIntents = detectParallelIntent(text);
      if (parallelIntents && !hasToolResults(prompt)) {
        return {
          content: parallelIntents.map((intent) => ({
            type: "tool-call" as const,
            toolCallId: `call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            toolName: intent.toolName,
            input: JSON.stringify(intent.args),
          })),
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      }

      const intent = detectToolIntent(prompt);
      if (intent) {
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: `call-${Date.now()}`,
              toolName: intent.toolName,
              input: JSON.stringify(intent.args),
            },
          ],
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      }

      return {
        content: [{ type: "text" as const, text: pickTextResponse(prompt) }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USAGE,
        warnings: [],
      };
    },

    async doStream({ prompt }: any) {
      const text = extractUserText(prompt);

      if (text.includes("测试重试") || text.includes("test retry")) {
        retryTestCount++;
        if (retryTestCount <= 2) {
          throw new Error("429 Too Many Requests - Rate limit exceeded");
        }
        retryTestCount = 0;
        const reply = "重试成功！";
        const id = "text-1";
        const chunks: any[] = [
          { type: "text-start", id },
          ...reply
            .split("")
            .map((char: string) => ({ type: "text-delta", id, delta: char })),
          { type: "text-end", id },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: USAGE,
          },
        ];
        return { stream: createDelayedStream(chunks, 30) };
      }

      const parallelIntents = detectParallelIntent(text);
      if (parallelIntents && !hasToolResults(prompt)) {
        return {
          stream: createDelayedStream(makeToolCallChunks(parallelIntents), 15),
        };
      }

      const intent = detectToolIntent(prompt);
      if (intent) {
        return {
          stream: createDelayedStream(makeToolCallChunks([intent]), 20),
        };
      }

      const replyText = pickTextResponse(prompt);
      const id = "text-1";
      const chunks: any[] = [
        { type: "text-start", id },
        ...replyText
          .split("")
          .map((char: string) => ({ type: "text-delta", id, delta: char })),
        { type: "text-end", id },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
        },
      ];
      return { stream: createDelayedStream(chunks, 30) };
    },
  };
}
