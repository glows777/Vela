import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LanguageModelUsage, ModelMessage } from 'ai';
import { toolResultOutputToText } from '../context/tool-result-output';

/**
 * 各家模型的 prompt cache 计费规则（单位：$ / 1M tokens，2026-05 数据）。
 *
 * 命中折扣不是行业默认 10x，每家差异不小：
 * - Claude：cache read = 10% input；write 5min = 125%、1h = 200%
 * - OpenAI：自动缓存，命中折扣按模型分档（4o 系列 50%，GPT-5 / 4.1 系列 25%）
 * - Gemini：cache read = 10% input（explicit 模式按存储时长另收费，这里没列）
 * - DeepSeek：cache hit = 10% miss，没有写入费、没有 TTL 概念
 * - Qwen：implicit 20%、explicit 10%（字段跟 Anthropic 一样是 `cache_control: ephemeral`）
 * - Kimi：自动模式 25%
 * - Doubao：显式 cache，命中价 = 40% miss
 *
 * 加新模型直接扩这张表就行。
 */
export interface ModelPricing {
  input: number;       // $ / 1M input tokens (cache miss)
  output: number;      // $ / 1M output tokens
  cacheWrite: number;  // $ / 1M tokens written to cache
  cacheRead: number;   // $ / 1M tokens read from cache (hit)
}

export const PRICE_TABLE: Record<string, ModelPricing> = {
  // Anthropic（最新主力，2026 上半年发布的 4.7 系列）
  'claude-opus-4-7':      { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-sonnet-4-7':    { input: 3.00,  output: 15.00, cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-haiku-4-5':     { input: 1.00,  output: 5.00,  cacheWrite: 1.25,  cacheRead: 0.10 },
  // OpenAI（GPT-5 系列；GPT-5.5 默认 24h extended cache）
  'gpt-5-5':              { input: 5.00,  output: 20.00, cacheWrite: 5.00,  cacheRead: 0.50 },
  'gpt-5':                { input: 5.00,  output: 15.00, cacheWrite: 5.00,  cacheRead: 1.25 },
  // Google（Gemini 3 系列，最新 preview）
  'gemini-3-pro':         { input: 2.50,  output: 12.00, cacheWrite: 2.50,  cacheRead: 0.625 },
  'gemini-3-flash':       { input: 0.30,  output: 1.20,  cacheWrite: 0.30,  cacheRead: 0.075 },
  // 国产
  'deepseek-v3-2':        { input: 0.27,  output: 1.10,  cacheWrite: 0.27,  cacheRead: 0.027 },
  'qwen3-6-plus':         { input: 0.40,  output: 1.20,  cacheWrite: 0.40,  cacheRead: 0.04 },
  'kimi-k2-6':            { input: 0.60,  output: 2.50,  cacheWrite: 0.60,  cacheRead: 0.15 },
  'doubao-2-0-pro':       { input: 0.30,  output: 0.90,  cacheWrite: 0.30,  cacheRead: 0.12 },
  // 课程内 mock，用 Haiku 4.5 同档价格
  'mock-model':           { input: 1.00,  output: 5.00,  cacheWrite: 1.25,  cacheRead: 0.10 },
};

export interface StepUsage {
  /** 未命中的输入 token，按普通 input 价格计费。 */
  inputTokens: number;
  /** 模型生成的输出 token。 */
  outputTokens: number;
  /** 命中已有 prompt cache 的输入 token。 */
  cacheReadTokens: number;
  /** 本次写入 prompt cache 的输入 token。 */
  cacheWriteTokens: number;
}

export interface StepRecord extends StepUsage {
  /** 这次模型请求完成时的 Unix 时间戳。 */
  ts: number;
  /** 这次请求使用的模型标识。 */
  model: string;
  /** 这次请求按价格表计算出的美元成本。 */
  cost: number;
}

export interface UsageTotals {
  /** 累计未命中的输入 token。 */
  inputTokens: number;
  /** 累计输出 token。 */
  outputTokens: number;
  /** 累计 cache read token。 */
  cacheReadTokens: number;
  /** 累计 cache write token。 */
  cacheWriteTokens: number;
  /** 累计实际成本。 */
  cost: number;
  /** cache read / 所有 input-like token。 */
  hitRate: number;
  /** 假设所有 input-like token 都未命中时的成本。 */
  baselineCost: number;
  /** 假设没有 cache 时节省的成本。 */
  savedCost: number;
  /** 已记录的模型请求数。 */
  steps: number;
}

export interface TokenStatus {
  /** 当前上下文估算 token 数。 */
  tokens: number;
  /** 当前上下文占固定窗口的百分比。 */
  percent: number;
  /** 是否达到需要采取上下文防护动作的阈值。 */
  needsAction: boolean;
}

/** 模型上下文窗口大小，用于 status 和 defense 的统一阈值。 */
export const CONTEXT_WINDOW = 200_000;

/**
 * 统一管理三种不同范围的 token 状态：
 *
 * 1. 当前上下文估算：给 defense / compaction 使用；
 * 2. 每次模型请求的 usage 和成本：给 /usage 使用；
 * 3. 当前一次 agentLoop 的预算：给 loop 熔断使用。
 *
 * 三者由同一个对象管理，但不会共用同一个数字。
 */
export class TokenTracker {
  /** 每次成功模型请求的 usage 明细，跨 agentLoop 累计。 */
  private steps: StepRecord[] = [];
  /** 可选的 JSONL usage 日志路径。 */
  private logPath?: string;
  /** 最近一次 API 返回的完整 prompt token 数。 */
  private lastPreciseCount = 0;
  /** 最近一次 API 校准后，尚未反映到 API 计数的消息字符增量。 */
  private pendingChars = 0;
  /** 当前一次 agentLoop 已消耗的输入加输出 token。 */
  private currentLoopTokens = 0;

  constructor(logPath?: string) {
    this.logPath = logPath;
    if (logPath) mkdirSync(dirname(logPath), { recursive: true });
  }

  /** 开始新的 agentLoop，只清空 loop budget，不清空历史 usage。 */
  beginLoop(): void {
    this.currentLoopTokens = 0;
  }

  /** 当前 agentLoop 累计的完整输入 token 和输出 token。 */
  get loopTokens(): number {
    return this.currentLoopTokens;
  }

  /** 用 API 返回的完整 prompt token 校准当前上下文基线。 */
  updateFromAPI(promptTokens: number): void {
    this.lastPreciseCount = promptTokens;
    this.pendingChars = 0;
  }

  /** 从已加载的消息历史建立当前上下文的初始估算。 */
  setEstimatedTokens(tokens: number): void {
    this.lastPreciseCount = Math.max(0, tokens);
    this.pendingChars = 0;
  }

  /** 把一条新消息的估算字符数加入当前上下文。 */
  addMessage(message: ModelMessage): void {
    this.pendingChars += countMessageChars(message);
  }

  /** 把多条新消息的估算字符数加入当前上下文。 */
  addMessages(messages: ModelMessage[]): void {
    for (const message of messages) {
      this.addMessage(message);
    }
  }

  /** 根据消息替换前后的字符差，修正当前上下文估算。 */
  replaceMessages(before: ModelMessage[], after: ModelMessage[]): void {
    this.pendingChars += countMessagesChars(after) - countMessagesChars(before);
  }

  /** 当前上下文 token 估算值：最近 API 基线加本地消息增量。 */
  get estimatedTokens(): number {
    return Math.max(0, this.lastPreciseCount + Math.ceil(this.pendingChars / 4));
  }

  /** 当前上下文相对 200k 窗口的状态。 */
  get status(): TokenStatus {
    const tokens = this.estimatedTokens;
    const percent = Math.round((tokens / CONTEXT_WINDOW) * 100);
    return {
      tokens,
      percent,
      needsAction: percent >= 75,
    };
  }

  /**
   * 记录一次模型请求，并把完整请求 token 加入当前 loop budget。
   * StepUsage.inputTokens 只代表未命中输入，所以预算需要加上两类 cache token。
   */
  record(model: string, usage: StepUsage): StepRecord {
    const requestPromptTokens =
      usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    const requestTotalTokens = requestPromptTokens + usage.outputTokens;
    this.currentLoopTokens += requestTotalTokens;

    const cost = computeCost(model, usage);
    const record: StepRecord = { ts: Date.now(), model, cost, ...usage };
    this.steps.push(record);

    if (this.logPath) {
      appendFileSync(this.logPath, JSON.stringify(record) + '\n');
    }
    return record;
  }

  /** 返回当前 tracker 生命周期内的累计 usage、cache 和成本。 */
  totals(): UsageTotals {
    const t = this.steps.reduce(
      (a, s) => ({
        inputTokens: a.inputTokens + s.inputTokens,
        outputTokens: a.outputTokens + s.outputTokens,
        cacheReadTokens: a.cacheReadTokens + s.cacheReadTokens,
        cacheWriteTokens: a.cacheWriteTokens + s.cacheWriteTokens,
        cost: a.cost + s.cost,
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
    );
    const totalInputLike = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
    const hitRate = totalInputLike > 0 ? t.cacheReadTokens / totalInputLike : 0;
    // 没有 cache 时的"假想成本"：把所有 input-like token 当成 miss 全付
    const baselineCost = (() => {
      let c = 0;
      for (const s of this.steps) {
        const p = (PRICE_TABLE[s.model] || PRICE_TABLE['mock-model'])!;
        const inputLike = s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens;
        c += (inputLike * p.input) / 1_000_000;
        c += (s.outputTokens * p.output) / 1_000_000;
      }
      return c;
    })();
    return { ...t, hitRate, baselineCost, savedCost: baselineCost - t.cost, steps: this.steps.length };
  }

  /** 返回最近的模型请求记录，不改变累计状态。 */
  recent(n: number): StepRecord[] {
    return this.steps.slice(-n);
  }
}

function countMessageChars(message: ModelMessage): number {
  let chars = 0;
  if (typeof message.content === 'string') {
    return message.content.length;
  }
  if (!Array.isArray(message.content)) return chars;

  for (const part of message.content) {
    if ('text' in part && typeof part.text === 'string') {
      chars += part.text.length;
    } else if ('output' in part) {
      chars += toolResultOutputToText(part.output).length;
    } else if ('input' in part) {
      chars += JSON.stringify(part.input)?.length ?? 0;
    }
  }
  return chars;
}

function countMessagesChars(messages: ModelMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += countMessageChars(message);
  }
  return chars;
}

/** 用消息字符数估算历史消息 token，供 context defense 使用。 */
export function estimateMessageTokens(messages: ModelMessage[]): number {
  const chars = countMessagesChars(messages);
  // 4 chars per token, with 1.2x safety factor for Chinese
  return Math.ceil((chars / 4) * 1.2);
}

export function computeCost(model: string, usage: StepUsage): number {
  const p = (PRICE_TABLE[model] || PRICE_TABLE['mock-model'])!;
  return (
    (usage.inputTokens * p.input
      + usage.outputTokens * p.output
      + usage.cacheReadTokens * p.cacheRead
      + usage.cacheWriteTokens * p.cacheWrite)
    / 1_000_000
  );
}

/**
 * 把 AI SDK 返回的 usage 对象规范化成四类 token。
 *
 * AI SDK v6 把输入 token 拆分到 `inputTokenDetails`：未命中、cache read 和 cache write。
 * `inputTokens` 是三类输入 token 的总数，这里保留原有 tracker 的四类计费口径，
 * 因此 `StepUsage.inputTokens` 表示未命中的输入 token。
 */
export function normalizeUsage(usage: LanguageModelUsage | undefined): StepUsage {
  if (!usage) return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  const cacheReadTokens = usage.inputTokenDetails.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails.cacheWriteTokens ?? 0;
  const inputTokens =
    usage.inputTokenDetails.noCacheTokens
    ?? Math.max(
      0,
      (usage.inputTokens ?? 0) - cacheReadTokens - cacheWriteTokens,
    );

  return {
    inputTokens: Math.max(0, inputTokens),
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens,
    cacheWriteTokens,
  };
}
