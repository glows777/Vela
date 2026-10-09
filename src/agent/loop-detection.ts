import { createHash } from 'node:crypto'

interface ToolHashedRecord {
  toolCallId: string
  name: string
  argsHash: string
}

// Two detectors. A "no progress" circuit breaker on identical calls is not needed: such calls are
// identical args too, so generic_repeat stops them at CRITICAL_THRESHOLD, long before the window could fill.
type DetectorKind =
  | 'generic_repeat' // same tool and args repeated too many times
  | 'ping_pong' // alternating between two sets of args

export type DetectionResult =
  | { stuck: false }
  | {
      stuck: true
      level: 'warning' | 'critical'
      detector: DetectorKind
      count: number
      message: string
    }

const HISTORY_SIZE = 30 // sliding window size
const WARNING_THRESHOLD = 10
const CRITICAL_THRESHOLD = 20

function stringifyValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stringifyValue).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stringifyValue((value as Record<string, unknown>)[k])}`).join(',')}}`
}

function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${hash(stringifyValue(params))}`
}

function recordToolCallIn(
  callHistory: ToolHashedRecord[],
  toolCallId: string,
  name: string,
  args: unknown,
) {
  callHistory.push({ toolCallId, name, argsHash: hashToolCall(name, args) })
  if (callHistory.length > HISTORY_SIZE) callHistory.shift()
}

/**
 * @description
 *    * Counts ping-pong alternations: the args hash alternates between two values, e.g. two
 *      operations A → B → A → B, where every step looks like it is "doing something".
 *    * Returns 0 if there is no alternation or fewer than 2 alternations;
 *    * otherwise returns the alternation count.
 * @param string currentHash args hash of the current call, used to check whether it switches back to the other hash
 * @returns number - the alternation count, or 0 if there is none or fewer than 2
 */
function getPingPongCount(
  callHistory: ToolHashedRecord[],
  currentHash: string,
): number {
  if (callHistory.length < 3) {
    return 0
  }

  const lastRecord = callHistory[callHistory.length - 1]
  let otherHash: string | undefined

  // From the second-to-last record backwards, find the first record with a different args hash
  for (let i = callHistory.length - 2; i >= 0; i--) {
    if (callHistory[i]?.argsHash !== lastRecord?.argsHash) {
      otherHash = callHistory[i]!.argsHash
      break
    }
  }

  // None found: no alternation
  if (!otherHash) {
    return 0
  }

  let count = 0
  for (let i = callHistory.length - 1; i >= 0; i--) {
    // Count only while lastRecord.argsHash and otherHash strictly alternate; stop at the first break
    const expectedHash = count % 2 === 0 ? lastRecord?.argsHash : otherHash
    if (callHistory[i]?.argsHash === expectedHash) {
      count++
    } else {
      break
    }
  }

  // Fewer than 2 alternations is not a real ping-pong
  if (currentHash === otherHash && count >= 2) {
    return count + 1
  }

  return 0
}

function detectLoopIn(
  callHistory: ToolHashedRecord[],
  name: string,
  args: unknown,
): DetectionResult {
  const argsHash = hashToolCall(name, args)
  const pingPong = getPingPongCount(callHistory, argsHash)
  if (pingPong >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'ping_pong',
      count: pingPong,
      message: `[critical] detect ping pong loop with ${pingPong} alternations, force stop and suggest checking the logic`,
    }
  }
  if (pingPong >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'ping_pong',
      count: pingPong,
      message: `[warning] detect ping pong loop with ${pingPong} alternations, suggest changing the logic`,
    }
  }

  const recentCount = callHistory.filter(
    (h) => h.name === name && h.argsHash === argsHash,
  ).length
  if (recentCount >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'generic_repeat',
      count: recentCount,
      message: `[critical] detect there has been ${recentCount} calls with same parameters, force stop and suggest checking the logic`,
    }
  }
  if (recentCount >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'generic_repeat',
      count: recentCount,
      message: `[warning] detect there has been ${recentCount} calls with same parameters, suggest checking if there is a loop in the logic`,
    }
  }

  return { stuck: false }
}

/**
 * Tool call loop detector. Each agent loop owns its own instance, so concurrent sessions
 * (e.g. multiple conversations in the channel gateway) don't share call history.
 */
export class LoopDetector {
  private readonly history: ToolHashedRecord[] = []

  record(toolCallId: string, name: string, args: unknown): void {
    recordToolCallIn(this.history, toolCallId, name, args)
  }

  detect(name: string, args: unknown): DetectionResult {
    return detectLoopIn(this.history, name, args)
  }

  reset(): void {
    this.history.length = 0
  }
}
