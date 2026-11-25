import type { ExecutionEnv } from '../execution/types.ts'
import { isToolContent, type ToolResultOutput } from '../messages.ts'
import { ToolResultError } from './types.ts'

export function normalOutput(output: unknown): ToolResultOutput {
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
