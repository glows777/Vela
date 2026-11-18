/**
 * Per-file mutation queue, ported from pi (pi-mono coding-agent
 * `src/core/tools/file-mutation-queue.ts`, MIT License, Copyright (c) 2025 Mario Zechner).
 */

import { resolve } from 'node:path'
import { createLocalExecutionEnv } from '../execution/local.ts'
import type { ExecutionEnv } from '../execution/types.ts'

// Process-wide, like pi: every session and every Vela in the process shares one queue per file
const fileMutationQueues = new Map<string, Promise<void>>()
let registrationQueue = Promise.resolve()

/**
 * Serializes mutations of the same file (resolved through symlinks).
 * Mutations of different files still run in parallel.
 */
export function withFileMutationQueue<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withEnvironmentMutationQueue(
    resolve(filePath),
    fn,
    createLocalExecutionEnv({ cwd: process.cwd() }),
  )
}

/** @internal Queue a mutation by its environment namespace and canonical path. */
export async function withEnvironmentMutationQueue<T>(
  filePath: string,
  fn: (canonicalPath: string) => Promise<T>,
  env: ExecutionEnv,
  signal?: AbortSignal,
): Promise<T> {
  const registration = registrationQueue.then(async () => {
    const result = await env.canonicalPath(filePath, signal)
    if (
      !result.ok &&
      result.error.code !== 'not_found' &&
      result.error.code !== 'not_directory'
    )
      throw result.error
    const canonical = result.ok ? result.value : filePath
    const key = `${env.id}:${canonical}`
    const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve()

    let releaseNext!: () => void
    const nextQueue = new Promise<void>((resolveQueue) => {
      releaseNext = resolveQueue
    })
    const chainedQueue = currentQueue.then(() => nextQueue)
    fileMutationQueues.set(key, chainedQueue)

    return { key, canonical, currentQueue, chainedQueue, releaseNext }
  })
  registrationQueue = registration.then(
    () => undefined,
    () => undefined,
  )

  const { key, canonical, currentQueue, chainedQueue, releaseNext } =
    await registration
  await currentQueue
  try {
    return await fn(canonical)
  } finally {
    releaseNext()
    if (fileMutationQueues.get(key) === chainedQueue)
      fileMutationQueues.delete(key)
  }
}
