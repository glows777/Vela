import type { ExecutionEnv } from '../execution/types.ts'
import {
  isToolContent,
  normalizeToolContent,
  type ToolResultOutput,
  toolContentText,
} from '../messages.ts'
import type {
  CallRecord,
  ResponseRecord,
  ResultRecord,
  ToolHistoryStore,
} from '../session/tool-history.ts'
import {
  type InterceptionContext,
  type ToolInterception,
  ToolResultError,
} from './types.ts'

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
function errorOutput(error: unknown): ToolResultOutput {
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

/** Binds lazy env resolution to the call's persisted history location, enforcing matching location on recovery. */
export function bindLocatedEnvResolver(
  requireEnv: (envSignal?: AbortSignal) => Promise<ExecutionEnv>,
  call: CallRecord,
  history: ToolHistoryStore,
  toolName: string,
  recoveryLocation: CallRecord['location'] | undefined,
  initiallyLocated: boolean,
): (envSignal?: AbortSignal) => Promise<ExecutionEnv> {
  let located = initiallyLocated
  let locating: Promise<void> | undefined
  return async (envSignal?: AbortSignal) => {
    const env = await requireEnv(envSignal)
    const envLoc = { environment: env.id, cwd: env.cwd }
    if (
      recoveryLocation &&
      JSON.stringify(envLoc) !== JSON.stringify(recoveryLocation)
    )
      throw new Error(
        `Tool ${toolName} was interrupted by a restart and may have partially run; its location changed, so it was not replayed`,
      )
    if (!located && call.replay === 'safe') {
      located = true
      call.location ??= envLoc
      const recorder = history as {
        locate?: (
          callId: string,
          loc: { environment: string; cwd: string },
        ) => Promise<void>
      }
      if (recorder.locate) {
        locating ??= recorder.locate(call.callId, envLoc)
      }
    }
    if (locating) await locating
    return env
  }
}

/** Runs after-interception, appends failed/cancelled tool history, and throws the normalized error. */
export async function handleToolExecutionError(params: {
  error: unknown
  name: string
  input: unknown
  started: number
  callId: string
  signal?: AbortSignal
  history: ToolHistoryStore
  interception?: ToolInterception
  context: InterceptionContext
}): Promise<never> {
  const {
    error,
    name,
    input,
    started,
    callId,
    signal,
    history,
    interception,
    context,
  } = params
  const rawMessage = error instanceof Error ? error.message : String(error)
  let errorText = rawMessage
  let afterOutput: string | ReturnType<typeof errorOutput> | unknown = errorText
  if (interception?.after) {
    afterOutput = await interception.after(
      name,
      input,
      errorText,
      context,
      true,
    )
    if (isToolContent(afterOutput)) {
      const normalized = await normalizeToolContent(afterOutput)
      afterOutput = normalized
      errorText = toolContentText(normalized) || errorText
    } else if (typeof afterOutput === 'string') {
      errorText = afterOutput
    }
  }
  await history.append<ResultRecord>({
    type: 'tool_result',
    callId,
    status: signal?.aborted ? 'cancelled' : 'failed',
    durationMs: performance.now() - started,
    error: errorText,
    modelOutput: errorOutput(
      isToolContent(afterOutput)
        ? new ToolResultError(errorText, afterOutput)
        : errorText,
    ),
  })
  if (isToolContent(afterOutput))
    throw new ToolResultError(errorText, afterOutput)
  if (typeof afterOutput === 'string' && afterOutput !== rawMessage)
    throw new ToolResultError(afterOutput)
  throw error
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
