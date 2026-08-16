import { expect, test } from "bun:test";
import type { LanguageModelUsage, ModelMessage } from "ai";
import { agentLoop } from "./agent/index";
import { createMockModel } from "./mock";
import { allTools } from "./tools";
import { ToolRegistry } from "./tools/registry";
import { normalizeUsage, TokenTracker } from "./usage/tracker";

function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(...allTools);
  return registry;
}

async function runMockAgent(prompt: string): Promise<{
  messages: ModelMessage[];
  tracker: TokenTracker;
}> {
  const messages: ModelMessage[] = [{ role: "user", content: prompt }];
  const tracker = new TokenTracker();

  await agentLoop({
    model: createMockModel(),
    systemPrompt: "你是一个用于测试的助手。",
    toolRegistry: createRegistry(),
    messages,
    tokenTracker: tracker,
  });

  return { messages, tracker };
}

test("normalizes AI SDK usage detail fields", () => {
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

test("keeps text response semantics with the mock model", async () => {
  const { messages, tracker } = await runMockAgent("你好");

  expect(messages).toHaveLength(2);
  expect(messages[0]?.role).toBe("user");
  expect(messages[1]?.role).toBe("assistant");
  expect(tracker.totals().steps).toBe(1);
});

test("keeps tool-call continuation semantics with the mock model", async () => {
  const { messages } = await runMockAgent("测试bash");

  expect(messages.map(message => message.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "assistant",
  ]);
}, 10_000);

test("keeps loop budget separate from cumulative usage", () => {
  const tracker = new TokenTracker();
  tracker.record("mock-model", {
    inputTokens: 60,
    cacheReadTokens: 30,
    cacheWriteTokens: 10,
    outputTokens: 7,
  });

  expect(tracker.loopTokens).toBe(107);
  expect(tracker.totals().steps).toBe(1);
  expect(tracker.totals().inputTokens).toBe(60);
  expect(tracker.totals().cacheReadTokens).toBe(30);
  expect(tracker.totals().cacheWriteTokens).toBe(10);

  tracker.beginLoop();
  expect(tracker.loopTokens).toBe(0);
  expect(tracker.totals().steps).toBe(1);
});
