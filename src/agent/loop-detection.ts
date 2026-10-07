interface ToolHashedRecord {
  toolCallId: string;
  name: string;
  argsHash: string;
  resultHash: string;
  timestamp: number;
}

type DetectorKind =
  | "generic_repeat" // 同工具同参数重复太多次
  | "ping_pong" // 两组参数来回切换
  | "global_circuit_breaker"; // 同工具同参数同结果持续无进展

export type DetectionResult =
  | { stuck: false }
  | {
      stuck: true;
      level: "warning" | "critical";
      detector: DetectorKind;
      count: number;
      message: string;
    };

const HISTORY_SIZE = 30; // 滑动窗口大小
const WARNING_THRESHOLD = 10; // 警告阈值
const CRITICAL_THRESHOLD = 20; // 严重阈值
const BREAKER_THRESHOLD = 30; // 熔断阈值

function stringifyValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stringifyValue).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stringifyValue((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

function hash(input: string): string {
  return Bun.CryptoHasher.hash("sha256", input, "hex").slice(0, 16);
}

export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${hash(stringifyValue(params))}`;
}

export function hashResult(result: unknown): string {
  return hash(stringifyValue(result));
}

function recordToolCallIn(
  callHistory: ToolHashedRecord[],
  toolCallId: string,
  name: string,
  args: unknown,
) {
  callHistory.push({
    toolCallId,
    name,
    argsHash: hashToolCall(name, args),
    resultHash: "", // 结果哈希将在调用完成后更新
    timestamp: Date.now(),
  });
  if (callHistory.length > HISTORY_SIZE) callHistory.shift();
}

function recordToolCallResultIn(
  callHistory: ToolHashedRecord[],
  toolCallId: string,
  name: string,
  args: unknown,
  result: unknown,
): boolean {
  const argsHash = hashToolCall(name, args);
  const resultHash = hashResult(result);

  const currentRecord = callHistory.find(
    (record) =>
      record.toolCallId === toolCallId &&
      record.name === name &&
      record.argsHash === argsHash &&
      record.resultHash === "",
  );
  if (!currentRecord) {
    return false;
  }

  currentRecord.resultHash = resultHash;
  return true;
}


/**
 * @description
 *    * 计算没有进展的连续调用次数。没有进展指的是在一段时间内结果哈希保持不变，说明调用虽然完成了，但没有产生新的结果。
 *    * 只有当参数哈希相同且结果哈希相同的连续调用才算作没有进展；如果参数哈希不同或者结果哈希不同，说明有进展，不计入连续调用次数。
 * @param string name - 工具名称
 * @param string argsHash - 参数哈希
 * @returns number - 没有进展的连续调用次数
 */
function getNoProgressStreak(
  callHistory: ToolHashedRecord[],
  name: string,
  argsHash: string,
): number {
  let streak = 0;
  let lastResultHash: string | null = null;

  for (let i = callHistory.length - 1; i >= 0; i--) {
    const currentRecord = callHistory[i];

    // 如果名字不一样或者参数不一样，说明不是同一个调用，继续往前找
    if (name !== currentRecord?.name || argsHash !== currentRecord.argsHash) {
      continue;
    }

    // 如果结果哈希还没有记录，说明调用还没有完成，继续往前找
    if (!currentRecord.resultHash) {
      continue;
    }

    // 如果没有上一个 hash 结果，说明这是第一次完成调用，记录结果哈希并继续往前找
    if (!lastResultHash) {
      lastResultHash = currentRecord.resultHash;
      streak = 1;
      continue;
    }

    // 如果结果哈希和上一个结果哈希一样，说明没有进展，增加 streak 计数；
    // 否则说明有进展，停止计数
    if (currentRecord.resultHash === lastResultHash) {
      streak++;
    }
  }

  return streak;
}

/**
 * @description
 *    * 计算来回切换的次数。来回切换指的是在一段时间内参数哈希在两个不同的值之间交替出现。比如： 两个操作来回交替，A → B → A → B，每一步看起来都在"做事"，
 *    * 如果没有来回切换或者来回切换的次数小于 2，返回 0；
 *    * 否则返回来回切换的次数。
 * @param string currentHash 当前调用的参数哈希，用于判断最后一次切换是否回到了当前参数哈希
 * @returns number - 来回切换的次数，如果没有来回切换或者来回切换的次数小于 2，返回 0；否则返回来回切换的次数
 */
function getPingPongCount(
  callHistory: ToolHashedRecord[],
  currentHash: string,
): number {
  if (callHistory.length < 3) {
    return 0;
  }

  const lastRecord = callHistory[callHistory.length - 1];
  let otherHash: string | undefined;

  // 从倒数第二条记录开始往前找，找到第一个参数哈希不同的记录，记下它的参数哈希
  for (let i = callHistory.length - 2; i >= 0; i--) {
    if (callHistory[i]?.argsHash !== lastRecord?.argsHash) {
      otherHash = callHistory[i]!.argsHash;
      break;
    }
  }

  // 如果没有找到参数哈希不同的记录，说明没有来回切换，直接返回 0
  if (!otherHash) {
    return 0;
  }

  let count = 0;
  for (let i = callHistory.length - 1; i >= 0; i--) {
    // 交替出现 lastRecord.argsHash 和 otherHash，才说明在来回切换；一旦出现不交替的情况，就停止计数
    const expectedHash = count % 2 === 0 ? lastRecord?.argsHash : otherHash;
    if (callHistory[i]?.argsHash === expectedHash) {
      count++;
    } else {
      break;
    }
  }

  // 如果来回切换的次数小于 2，说明来回切换不频繁，不算真正的来回切换，返回 0；否则返回来回切换的次数
  if (currentHash === otherHash && count >= 2) {
    return count + 1;
  }

  return 0;
}

function detectLoopIn(
  callHistory: ToolHashedRecord[],
  name: string,
  args: unknown,
): DetectionResult {
  const argsHash = hashToolCall(name, args);
  const noProgress = getNoProgressStreak(callHistory, name, argsHash);

  if (noProgress >= BREAKER_THRESHOLD) {
    return {
      stuck: true,
      level: "critical",
      detector: "global_circuit_breaker",
      count: noProgress,
      message: `[critical]: detect there has been ${noProgress} consecutive calls without progress, force stop and suggest checking the tool implementation`,
    };
  }

  const pingPong = getPingPongCount(callHistory, argsHash);
  if (pingPong >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: "critical",
      detector: "ping_pong",
      count: pingPong,
      message: `[critical] detect ping pong loop with ${pingPong} alternations, force stop and suggest checking the logic`,
    };
  }
  if (pingPong >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: "warning",
      detector: "ping_pong",
      count: pingPong,
      message: `[warning] detect ping pong loop with ${pingPong} alternations, suggest changing the logic`,
    };
  }

  const recentCount = callHistory.filter(
    (h) => h.name === name && h.argsHash === argsHash,
  ).length;
  if (recentCount >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: "critical",
      detector: "generic_repeat",
      count: recentCount,
      message: `[critical] detect there has been ${recentCount} calls with same parameters, force stop and suggest checking the logic`,
    };
  }
  if (recentCount >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: "warning",
      detector: "generic_repeat",
      count: recentCount,
      message: `[warning] detect there has been ${recentCount} calls with same parameters, suggest checking if there is a loop in the logic`,
    };
  }

  return { stuck: false };
}

/**
 * 工具调用循环检测器。每个 agent loop 持有自己的实例，
 * 并发会话（例如通道网关里的多个对话）不会共享调用历史。
 */
export class LoopDetector {
  private readonly history: ToolHashedRecord[] = [];

  record(toolCallId: string, name: string, args: unknown): void {
    recordToolCallIn(this.history, toolCallId, name, args);
  }

  recordResult(
    toolCallId: string,
    name: string,
    args: unknown,
    result: unknown,
  ): boolean {
    return recordToolCallResultIn(this.history, toolCallId, name, args, result);
  }

  detect(name: string, args: unknown): DetectionResult {
    return detectLoopIn(this.history, name, args);
  }

  reset(): void {
    this.history.length = 0;
  }
}

// 兼容旧的模块级 API：共享一个默认实例。
const defaultDetector = new LoopDetector();
export const recordToolCall = (
  toolCallId: string,
  name: string,
  args: unknown,
) => defaultDetector.record(toolCallId, name, args);
export const recordToolCallResult = (
  toolCallId: string,
  name: string,
  args: unknown,
  result: unknown,
) => defaultDetector.recordResult(toolCallId, name, args, result);
export const detectLoop = (name: string, args: unknown) =>
  defaultDetector.detect(name, args);
export const resetHistory = () => defaultDetector.reset();
