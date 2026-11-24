import type { ExecutionEnv } from '../execution/types.ts'
import {
  isToolContent,
  type ToolResultOutput,
  toolContentText,
} from '../messages.ts'
import type {
  CallRecord,
  ResponseRecord,
  ResultRecord,
  ToolHistoryStore,
} from '../session/tool-history.ts'
import { ToolResultError } from './types.ts'

/** An availability check or hook turned the call down; the model gets `reason` as an error result. */
export class ToolRejection {
  constructor(readonly reason: string) {}
}

export async function recoverToolCall<T extends { replay?: 'safe' | 'unsafe' }>(
  registry: {
    get(name: string): T | undefined
    assertHealthy(): void
    results: { history: ToolHistoryStore }
  },
  name: string,
  id: string,
  input: unknown,
  signal: AbortSignal | undefined,
  run: (tool: T, input: unknown, recovery: CallRecord) => Promise<unknown>,
): Promise<ToolResultOutput> {
  const attempts = await registry.results.history.attempts(id)
  const last = attempts.at(-1)
  if (last?.result?.modelOutput) return last.result.modelOutput
  const unknown = (detail = ''): ToolResultOutput => ({
    type: 'error-text',
    value: `Tool ${name} was interrupted by a restart and may have partially run. Do not blindly repeat it; verify its effects first.${detail}`,
  })
  // A terminal native result without the exact post-hook response is not permission to repeat effects.
  if (last?.result)
    return unknown(
      ' Its native result was saved, but its final model response was not saved.',
    )
  const tool = registry.get(name)
  if (
    last?.call.replay !== 'safe' ||
    tool?.replay !== 'safe' ||
    last.call.toolName !== name ||
    JSON.stringify(last.call.input) !== JSON.stringify(input)
  )
    return unknown()
  const interrupted = (last.call.interruption ?? 0) + 1
  if (interrupted >= 5)
    return {
      type: 'error-text',
      value: `Tool ${name} was interrupted ${interrupted} times in a row; it is not run again`,
    }
  signal?.throwIfAborted()
  try {
    const output = await run(tool, input, last.call)
    registry.assertHealthy()
    return output instanceof ToolRejection
      ? errorOutput(output.reason)
      : normalOutput(output)
  } catch (error) {
    registry.assertHealthy()
    if (signal?.aborted) throw error
    return errorOutput(error)
  }
}

function normalOutput(output: unknown): ToolResultOutput {
  return isToolContent(output)
    ? { type: 'content', value: output }
    : typeof output === 'string'
      ? { type: 'text', value: output }
      : { type: 'json', value: (output ?? null) as never }
}
export function errorOutput(error: unknown): ToolResultOutput {
  return error instanceof ToolResultError && error.content
    ? { type: 'content', value: error.content, isError: true }
    : {
        type: 'error-text',
        value: error instanceof Error ? error.message : String(error),
      }
}

export async function persistResponse(
  history: ToolHistoryStore,
  callId: string,
  output: unknown,
  isError?: boolean,
) {
  await history.append<ResponseRecord>({
    type: 'tool_response',
    callId,
    output: isError
      ? errorOutput(
          new ToolResultError(
            (typeof output === 'string'
              ? output
              : isToolContent(output)
                ? toolContentText(output)
                : '') || 'Tool reported an error',
            isToolContent(output) ? output : undefined,
          ),
        )
      : normalOutput(output),
  })
}

/** Caches in-flight and settled ExecutionEnv resolution per tool call invocation. */
export function createLazyEnvResolver(
  resolve: (signal?: AbortSignal) => Promise<ExecutionEnv>,
  callSignal: AbortSignal | undefined,
  onResolved: (env: ExecutionEnv) => void,
  getResolved: () => ExecutionEnv | undefined,
): (envSignal?: AbortSignal) => Promise<ExecutionEnv> {
  let pending: Promise<ExecutionEnv> | undefined
  return (envSignal) => {
    const target = envSignal ?? callSignal
    target?.throwIfAborted()
    const resolved = getResolved()
    if (resolved) return Promise.resolve(resolved)
    if (!pending) {
      pending = resolve(callSignal).then(
        (env) => {
          onResolved(env)
          return env
        },
        (err) => {
          pending = undefined
          throw err
        },
      )
    }
    if (!envSignal || envSignal === callSignal) return pending
    return new Promise<ExecutionEnv>((resolveEnv, rejectEnv) => {
      const onAbort = () => rejectEnv(envSignal.reason)
      if (envSignal.aborted) return onAbort()
      envSignal.addEventListener('abort', onAbort, { once: true })
      pending!.then(
        (env) => {
          envSignal.removeEventListener('abort', onAbort)
          resolveEnv(env)
        },
        (err) => {
          envSignal.removeEventListener('abort', onAbort)
          rejectEnv(err)
        },
      )
    })
  }
}

/** Per call: how the call was issued */
export interface CallOptions {
  recovery?: CallRecord
  toolCallId?: string
  abortSignal?: AbortSignal
  onUpdate?: (partialResult: unknown) => void
}

/** Refusal before execution is a known result, unlike a tool interrupted after it started. */
export async function rejectDrainingCall(
  history: ToolHistoryStore,
  name: string,
  id: string | undefined,
  input: unknown,
  call?: CallRecord,
): Promise<ToolRejection> {
  const reason = `Tool ${name} was not executed because the session is shutting down`
  const attempt = call ?? (await history.begin(name, id, input))
  await history.append<ResultRecord>({
    type: 'tool_result',
    callId: attempt.callId,
    status: 'rejected',
    durationMs: 0,
    error: reason,
    modelOutput: errorOutput(reason),
  })
  return new ToolRejection(reason)
}

export async function recordToolRejection(
  history: ToolHistoryStore,
  toolName: string,
  toolCallId: string,
  input: unknown,
  error: unknown,
): Promise<void> {
  if (history.hasAttempt(toolCallId)) return
  const call = await history.begin(toolName, toolCallId, input)
  await history.append<ResultRecord>({
    type: 'tool_result',
    callId: call.callId,
    status: 'rejected',
    durationMs: 0,
    error: error instanceof Error ? error.message : String(error),
  })
}
