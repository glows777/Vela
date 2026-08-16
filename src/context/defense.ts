import type { ModelMessage } from 'ai';
import { textToolResultOutput, toolResultOutputToText } from './tool-result-output';

// ── Layer 1: Token Estimation ────────────────────────

export class TokenTracker {
  private lastPreciseCount = 0;
  private pendingChars = 0;

  updateFromAPI(promptTokens: number): void {
    this.lastPreciseCount = promptTokens;
    this.pendingChars = 0;
  }

  setEstimatedTokens(tokens: number): void {
    this.lastPreciseCount = Math.max(0, tokens);
    this.pendingChars = 0;
  }

  addMessage(message: ModelMessage): void {
    this.pendingChars += countMessageChars(message);
  }

  addMessages(messages: ModelMessage[]): void {
    for (const message of messages) {
      this.addMessage(message);
    }
  }

  replaceMessages(before: ModelMessage[], after: ModelMessage[]): void {
    this.pendingChars += countMessagesChars(after) - countMessagesChars(before);
  }

  get estimatedTokens(): number {
    return Math.max(0, this.lastPreciseCount + Math.ceil(this.pendingChars / 4));
  }

  get status(): { tokens: number; percent: number; needsAction: boolean } {
    const tokens = this.estimatedTokens;
    const percent = Math.round((tokens / CONTEXT_WINDOW) * 100);
    return {
      tokens,
      percent,
      needsAction: percent >= 75,
    };
  }
}

const CONTEXT_WINDOW = 200_000;

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

export function estimateMessageTokens(messages: ModelMessage[]): number {
  const chars = countMessagesChars(messages);
  // 4 chars per token, with 1.2x safety factor for Chinese
  return Math.ceil((chars / 4) * 1.2);
}

// ── Layer 2: Dynamic Tool Result Truncation ──────────

interface TruncationConfig {
  maxSingleResult: number;
  contextBudgetChars: number;
}

const DEFAULT_TRUNCATION: TruncationConfig = {
  maxSingleResult: Math.floor(CONTEXT_WINDOW * 0.5 * 2),   // 50% of window, 2 chars/token
  contextBudgetChars: Math.floor(CONTEXT_WINDOW * 0.75 * 4), // 75% of window, 4 chars/token
};

export function truncateToolResults(
  messages: ModelMessage[],
  config: TruncationConfig = DEFAULT_TRUNCATION,
): { messages: ModelMessage[]; truncated: number; compacted: number } {
  let truncated = 0;
  let compacted = 0;

  // Pass 1: single-result truncation (Head/Tail 60/40)
  let result = messages.map(msg => {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;

    const newContent = msg.content.map((part: any) => {
      if (!part.output) return part;
      const outputText = toolResultOutputToText(part.output);
      if (outputText.length <= config.maxSingleResult) return part;

      truncated++;
      const maxChars = config.maxSingleResult;
      const headSize = Math.floor(maxChars * 0.6);
      const tailSize = Math.floor(maxChars * 0.4);
      const head = outputText.slice(0, headSize);
      const tail = outputText.slice(-tailSize);

      return {
        ...part,
        output: textToolResultOutput(`${head}\n\n[truncated: ${outputText.length} → ${maxChars} chars]\n\n${tail}`),
      };
    });

    return { ...msg, content: newContent };
  });

  // Pass 2: total budget enforcement — compact oldest tool results first
  let totalChars = result.reduce((sum, msg) => {
    if (typeof msg.content === 'string') return sum + msg.content.length;
    if (Array.isArray(msg.content)) {
      return sum + (msg.content as any[]).reduce((s, p) =>
        s + (p.output ? toolResultOutputToText(p.output).length : (p.text as string)?.length || 0), 0);
    }
    return sum;
  }, 0);

  if (totalChars > config.contextBudgetChars) {
    for (let i = 0; i < result.length && totalChars > config.contextBudgetChars; i++) {
      const msg = result[i]!;
      if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue;
      const toolName = ((msg.content as any[])[0])?.toolName || 'unknown';
      const oldSize = (msg.content as any[]).reduce((s: number, p: any) =>
        s + (p.output ? toolResultOutputToText(p.output).length : 0), 0);
      result[i] = {
        ...msg,
        content: (msg.content as any[]).map((p: any) => ({
          ...p,
          output: textToolResultOutput(`[compacted: ${toolName} output removed to free context]`),
        })),
      };
      totalChars -= oldSize;
      compacted++;
    }
  }

  return { messages: result, truncated, compacted };
}

// ── Layer 3: TTL Pruning ─────────────────────────────

interface TTLConfig {
  softTTLMs: number;
  hardTTLMs: number;
  keepHeadTail: number;
}

const DEFAULT_TTL: TTLConfig = {
  softTTLMs: 5 * 60 * 1000,    // 5 minutes
  hardTTLMs: 10 * 60 * 1000,   // 10 minutes
  keepHeadTail: 1500,           // chars to keep in soft prune
};

export interface PruneResult {
  messages: ModelMessage[];
  softPruned: number;
  hardPruned: number;
}

export function ttlPrune(
  messages: ModelMessage[],
  timestamps: Map<ModelMessage, number>,
  config: TTLConfig = DEFAULT_TTL,
): PruneResult {
  const now = Date.now();
  let softPruned = 0;
  let hardPruned = 0;

  const result = messages.map(msg => {
    // Only prune tool results, never user/assistant messages
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;

    const ts = timestamps.get(msg);
    if (!ts) return msg;

    const age = now - ts;

    // Preserve error experiences — never prune failed tool results
    const outputText = (msg.content as any[])
      .map((p: any) => p.output ? toolResultOutputToText(p.output) : '')
      .join('');
    if (outputText.trim().startsWith('[tool result expired:')) return msg;

    const isError = /error|失败|不存在|denied|refused|timeout/i.test(outputText);
    if (isError) return msg;

    // Hard clear: replace entire content with placeholder
    if (age >= config.hardTTLMs) {
      hardPruned++;
      const toolName = (msg.content[0] as any)?.toolName || 'unknown';
      return {
        ...msg,
        content: msg.content.map((part: any) => ({
          ...part,
          output: textToolResultOutput(`[tool result expired: ${toolName}]`),
        })),
      };
    }

    // Soft prune: keep head + tail, replace middle
    if (age >= config.softTTLMs) {
      const newContent = msg.content.map((part: any) => {
        if (!part.output) return part;
        const outputText = toolResultOutputToText(part.output);
        if (outputText.length <= config.keepHeadTail * 2) return part;

        softPruned++;
        const head = outputText.slice(0, config.keepHeadTail);
        const tail = outputText.slice(-config.keepHeadTail);
        const removed = outputText.length - config.keepHeadTail * 2;

        return {
          ...part,
          output: textToolResultOutput(`${head}\n\n[soft pruned: ${removed} chars removed, content older than ${Math.round(config.softTTLMs / 60000)}min]\n\n${tail}`),
        };
      });
      return { ...msg, content: newContent };
    }

    return msg;
  });

  return { messages: result, softPruned, hardPruned };
}

// ── Combined Defense ─────────────────────────────────

export interface DefenseResult {
  messages: ModelMessage[];
  tokenEstimate: number;
  truncated: number;
  compacted: number;
  softPruned: number;
  hardPruned: number;
}

export function applyDefense(
  messages: ModelMessage[],
  timestamps: Map<ModelMessage, number>,
): DefenseResult {
  // Layer 2: truncate oversized tool results
  const trunc = truncateToolResults(messages);
  let result = trunc.messages;

  // Truncation may clone tool messages, so carry their original timestamps
  // into the next defense layer before pruning by age.
  const timestampsAfterTruncation = new Map<ModelMessage, number>();
  result.forEach((message, index) => {
    const timestamp = timestamps.get(messages[index]!);
    if (timestamp !== undefined) {
      timestampsAfterTruncation.set(message, timestamp);
    }
  });

  // Layer 3: TTL prune old tool results
  const prune = ttlPrune(result, timestampsAfterTruncation);
  result = prune.messages;

  // Layer 1: estimate final token count
  const tokenEstimate = estimateMessageTokens(result);

  return {
    messages: result,
    tokenEstimate,
    truncated: trunc.truncated,
    compacted: trunc.compacted,
    softPruned: prune.softPruned,
    hardPruned: prune.hardPruned,
  };
}
