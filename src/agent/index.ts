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
} from "./loop-detection";
import { calculateDelay, isRetryable, sleep } from "./retry";
import type { ToolRegistry } from "../tools/registry";
import type { TokenTracker } from "../context/defense";

const MAX_TURN = 15;
const MAX_RETRIES = 3;
const TOKEN_BUDGET = 50 * 1000;

export interface BudgetState {
  used: number;
  limit: number;
}

interface AgentLoopParameter {
  model: LanguageModel;
  systemPrompt: string;
  toolRegistry: ToolRegistry;
  messages: ModelMessage[];
  tracker: TokenTracker,
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
  toolRegistry,
  messages,
  tracker
}: AgentLoopParameter) => {
  let turn = 0;
  let totalTokens = 0;
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
          tools: toolRegistry.toAISDKFormat(),
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

    const inputToken = finalUsage?.inputTokens?.total ?? finalUsage?.inputTokens ?? 0;
    const outputToken = finalUsage?.outputTokens?.total ?? finalUsage?.outputTokens ?? 0;
    if (inputToken > 0) tracker.updateFromAPI(inputToken);

    const responseMessages = finalResponse!.messages as ModelMessage[];
    messages.push(...responseMessages);
    tracker.addMessages(responseMessages);

    totalTokens += inputToken + outputToken;
    if (totalTokens > TOKEN_BUDGET * 0.9) {
      console.log(`  [Token] ${totalTokens}/${TOKEN_BUDGET} (${Math.round(totalTokens / TOKEN_BUDGET * 100)}%)`);
    }
    if (totalTokens > TOKEN_BUDGET) {
      console.log('\n[Token has exceeded the budget limit. Ending loop.]');
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
