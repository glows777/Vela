import {
  generateText,
  type LanguageModel,
  type ModelMessage,
  type ToolModelMessage,
  type ToolResultPart,
} from "ai";
import { estimateMessageTokens } from "./defense";
import { toolResultOutputToText } from "./tool-result-output";

const CLEARABLE_TOOLS = new Set([
  "read_file",
  "bash",
  "grep",
  "glob",
  "list_directory",
  "edit_file",
  "write_file",
]);
const KEEP_RECENT_TOOL_RESULTS = 3;

export function microcompact(messages: ModelMessage[]): {
  messages: ModelMessage[];
  cleared: number;
} {
  const toolResultIndices: number[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "tool") {
      toolResultIndices.push(i);
    }
  }

  const toClearMsgIndex = toolResultIndices.slice(
    0,
    Math.max(0, toolResultIndices.length - KEEP_RECENT_TOOL_RESULTS),
  );

  let cleared = 0;
  const result = messages.map((msg, index) => {
    if (!toClearMsgIndex.includes(index)) {
      return msg;
    }
    const toolName = (msg.content[0] as ToolResultPart).toolName || "unknown";
    if (!CLEARABLE_TOOLS.has(toolName)) {
      return msg;
    }

    const toolMsg = msg as ToolModelMessage;
    const hasLiveOutput = toolMsg.content.some(
      part =>
        part.type === "tool-result" &&
        !/^\[(tool result cleared|compacted:|tool result expired:)/.test(
          toolResultOutputToText(part.output).trim(),
        ),
    );
    if (!hasLiveOutput) {
      return msg;
    }

    cleared++;
    return {
      ...toolMsg,
      content: toolMsg.content.map((part) =>
        part.type === "tool-result"
          ? {
              ...part,
              output: { type: "text", value: "[tool result cleared]" },
            }
          : part,
      ),
    } satisfies ToolModelMessage;
  });

  return {
    cleared,
    messages: result,
  };
}

const COMPRESS_PROMPT = `你是一个对话压缩系统。你的任务是把 Agent 和用户之间的对话历史压缩成一份结构化摘要，确保后续对话能够无缝继续。

请严格按照以下模板输出，每个字段都要填写。如果某个字段没有相关内容，写"无"：

## 用户意图
（用户在这次对话中想要完成什么）

## 已完成的操作
（Agent 执行了哪些工具调用、产生了什么结果）

## 关键发现
（读取的文件内容要点、搜索结果、命令输出中的关键信息）

## 当前状态
（对话进行到哪一步了、还有什么没做完）

## 需要保留的细节
（文件路径、变量名、配置值、错误信息等不能丢失的具体内容）

注意事项：
- 用对话中使用的语言（中文或英文）输出
- 文件路径、UUID、版本号等标识符必须原样保留，不要翻译或改写
- 不要写笼统的概述，只保留具体的、可操作的信息
- 总长度控制在 800 字以内`;

export const MICROCOMPACT_TOKEN_THRESHOLD = 120 * 1000;
export const SUMMARY_TOKEN_THRESHOLD = 150 * 1000;
const KEEP_RECENT_MESSAGES = 6;

export interface CompactionResult {
  messages: ModelMessage[];
  summary: string;
  compressedCount: number;
}

export async function summarize(
  model: LanguageModel,
  messages: ModelMessage[],
  existingSummary?: string,
  tokenEstimate = estimateMessageTokens(messages),
): Promise<CompactionResult> {
  if (tokenEstimate < SUMMARY_TOKEN_THRESHOLD) {
    return {
      messages,
      summary: existingSummary || "",
      compressedCount: 0,
    };
  }

  // * 找到最近 N 条消息，这些消息需要被压缩
  // * 剩余最近的 KEEP_RECENT_MESSAGES 条不要压缩
  const splitIndex = Math.max(0, messages.length - KEEP_RECENT_MESSAGES);

  // * 确保保留的消息必须是 user 开头
  // * 如果不这么做，否则保留的消息列表可能会以非 user 开头，很多情况下不已 user 开头的消息， llm server 侧会报错
  let index = splitIndex;
  while (index > 0 && messages[index]!.role !== "user") {
    index--;
  }
  if (index === 0) {
    return {
      messages,
      compressedCount: 0,
      summary: existingSummary || "",
    };
  }

  const messagesToBeCompressed = messages.slice(0, index);
  const messagesToBeKept = messages.slice(index);

  // * 把消息都转为 string
  const conversationText = messagesToBeCompressed
    .map((msg) => {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .map((part) =>
                  "text" in part
                    ? part.text
                    : "output" in part
                      ? JSON.stringify(part.output, null, 2)
                      : "",
                )
                .join("\n")
            : "";
      return content ? `**${msg.role}**: ${content}` : "";
    })
    .filter(Boolean)
    .join("\n\n");

  if (!conversationText.trim()) {
    return { messages, summary: existingSummary || "", compressedCount: 0 };
  }
  const userPrompt = existingSummary
    ? `## 已有摘要（上一次压缩的结果）\n\n${existingSummary}\n\n## 需要压缩的新对话\n\n${conversationText}`
    : conversationText;

  try {
    const result = await generateText({
      model,
      instructions: COMPRESS_PROMPT,
      prompt: userPrompt,
    });

    const summaryMessage: ModelMessage = {
      role: "user",
      content: `[以下是之前对话的压缩摘要]\n\n${result.text}\n\n[摘要结束，以下是最近的对话]`,
    };

    const newMessages: ModelMessage[] = [summaryMessage, ...messagesToBeKept];

    return {
      messages: newMessages,
      summary: result.text,
      compressedCount: messagesToBeCompressed.length,
    };
  } catch (error) {
    console.error("[Compaction] LLM 摘要失败:", error);
    return { messages, summary: existingSummary || "", compressedCount: 0 };
  }
}
