import {
  streamText,
  type LanguageModel,
  type ModelMessage,
  type Tool,
  type ToolSet,
} from "ai";
import {
  detectLoop,
  recordToolCall,
  recordToolCallResult,
  resetHistory,
} from "./tools/loop-detection";
import { calculateDelay, isRetryable, sleep } from "./utils/retry";

const MAX_TURN = 15;
const MAX_RETRIES = 3;

export interface BudgetState {
  used: number;
  limit: number;
}

interface AgentLoopParameter {
  model: LanguageModel;
  systemPrompt: string;
  tools: ToolSet | Tool[];
  messages: ModelMessage[];
  budget: BudgetState;
}

// support tools as array or object, if array, convert to object with title as key
const resolveTools = (tools: ToolSet | Tool[]): ToolSet => {
  if (!Array.isArray(tools)) {
    return tools;
  }

  return tools.reduce<ToolSet>((resolvedTools, tool) => {
    const title = tool.title?.trim();

    if (!title) {
      throw new Error("Tool arrays require every tool to have a title.");
    }

    if (Object.hasOwn(resolvedTools, title)) {
      throw new Error(`Duplicate tool title: ${title}`);
    }

    resolvedTools[title] = tool;
    return resolvedTools;
  }, {});
};

export const agentLoop = async ({
  model,
  systemPrompt,
  tools,
  messages,
  budget,
}: AgentLoopParameter) => {
  let turn = 0;
  resetHistory(); // 每次新的 agent loop 开始时重置工具调用历史

  while (turn < MAX_TURN) {
    turn++;
    console.log(`\n--- Agent Loop Turn ${turn} ---\n`);

    let needToolCall = false;
    let fullContent = "";
    let shouldBreak = false;
    let lastToolCall: { name: string; input: unknown } | null = null;
    let finalResponse:
      | Awaited<ReturnType<typeof streamText>["response"]>
      | undefined;
    let finalUsage: Awaited<ReturnType<typeof streamText>["usage"]>;

    for (let attempt = 1; ; attempt++) {
      try {
        const result = streamText({
          model,
          system: systemPrompt,
          tools: resolveTools(tools),
          messages,
          maxRetries: 0, // 禁止 streamText 内部重试，交由外层控制重试逻辑
        });

        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta": {
              process.stdout.write(part.text);
              fullContent += part.text;
              break;
            }
            case "tool-call": {
              needToolCall = true;
              lastToolCall = { name: part.toolName, input: part.input };
              console.log(
                `\n  [tool called: ${part.toolName}->(${JSON.stringify(part.input)})]`,
              );

              const detectResult = detectLoop(part.toolName, part.input);
              if (detectResult.stuck) {
                console.log(detectResult.message);
                if (detectResult.level === "critical") {
                  shouldBreak = true;
                } else if (detectResult.level === "warning") {
                  messages.push({
                    role: "user",
                    content: `[system message] ${detectResult.message}.\n Please change your idea and try again.Don't repeat the same tool call again.`,
                  });
                }
              }
              recordToolCall(part.toolName, part.input);
              break;
            }
            case "tool-result": {
              if (lastToolCall) {
                recordToolCallResult(part.toolName, part.input, part.output);
              }
              console.log(
                `  [tool called result: ${part.toolName}->${JSON.stringify(part.output)}]`,
              );
              break;
            }
          }
        }

        finalResponse = await result.response;
        finalUsage = await result.usage;
        break;
      } catch (error) {
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error;
        const delay = calculateDelay(attempt);
        console.log(
          `  [Retry] Attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delay}ms...`,
        );
        await sleep(delay);
        needToolCall = false;
        fullContent = "";
        shouldBreak = false;
        lastToolCall = null;
      }
    }

    if (!finalResponse) {
      throw new Error("Agent loop did not receive a final response.");
    }

    if (shouldBreak) {
      console.log(
        "\nAgent is stuck in a loop and has reached the critical threshold. Ending loop.",
      );
      break;
    }

    messages.push(...finalResponse.messages);

    // Token 预算追踪：budget 由调用方持有，跨轮持续累计
    budget.used +=
      finalUsage.totalTokens ??
      (finalUsage.inputTokens ?? 0) + (finalUsage.outputTokens ?? 0);
    const pct = Math.round((budget.used / budget.limit) * 100);
    console.log(`\n[Token] ${budget.used}/${budget.limit} (${pct}%)`);
    if (budget.used > budget.limit) {
      console.log("\nAgent has exceeded the token budget. Ending loop.");
      break;
    }

    if (!needToolCall) {
      console.log("\n--- Agent has completed its response. Ending loop. ---");
      break;
    }

    console.log("agent needs to call tool, continue to next turn");
  }

  if (turn >= MAX_TURN) {
    console.log(
      "\nReached maximum turn limit. Ending loop to prevent infinite execution.",
    );
  }
};
