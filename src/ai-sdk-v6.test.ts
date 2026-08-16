import { expect, test } from "bun:test";
import type { LanguageModelUsage, ModelMessage } from "ai";
import { agentLoop } from "./agent/index";
import { TokenTracker } from "./context/defense";
import { createMockModel } from "./mock";
import { allTools } from "./tools";
import { ToolRegistry } from "./tools/registry";
import { normalizeUsage, UsageTracker } from "./usage/tracker";

function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(...allTools);
  return registry;
}

async function runMockAgent(prompt: string): Promise<{
  messages: ModelMessage[];
  usage: UsageTracker;
}> {
  const messages: ModelMessage[] = [{ role: "user", content: prompt }];
  const usage = new UsageTracker();

  await agentLoop({
    model: createMockModel(),
    systemPrompt: "你是一个用于测试的助手。",
    toolRegistry: createRegistry(),
    messages,
    tokenTracker: new TokenTracker(),
    usageTracker: usage,
  });

  return { messages, usage };
}

test("normalizes AI SDK v6 usage detail fields", () => {
  const usage: LanguageModelUsage = {
    inputTokens: 100,
    inputTokenDetails: {
      noCacheTokens: 60,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
    },
    outputTokens: 7,
    outputTokenDetails: {
      textTokens: 7,
      reasoningTokens: undefined,
    },
    totalTokens: 107,
  };

  expect(normalizeUsage(usage)).toEqual({
    inputTokens: 60,
    outputTokens: 7,
    cacheReadTokens: 30,
    cacheWriteTokens: 10,
  });
});

test("keeps text response semantics with the v6 mock model", async () => {
  const { messages, usage } = await runMockAgent("你好");

  expect(messages).toHaveLength(2);
  expect(messages[0]?.role).toBe("user");
  expect(messages[1]?.role).toBe("assistant");
  expect(usage.totals().steps).toBe(1);
});

test("keeps tool-call continuation semantics with the v6 mock model", async () => {
  const { messages } = await runMockAgent("测试bash");

  expect(messages.map(message => message.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "assistant",
  ]);
}, 10_000);
