/**
 * Per-file mutation queue, ported from pi (pi-mono coding-agent
 * `src/core/tools/file-mutation-queue.ts`, MIT License, Copyright (c) 2025 Mario Zechner).
 */

import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ExecutionEnv } from '../execution/types.ts'

// Process-wide, like pi: every session and every Vela in the process shares one queue per file
const fileMutationQueues = new Map<string, Promise<void>>()
let registrationQueue = Promise.resolve()

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

async function getMutationQueueKey(filePath: string): Promise<string> {
  const resolvedPath = resolve(filePath)
  try {
    return await realpath(resolvedPath)
  } catch (error) {
    if (isMissingPathError(error)) return resolvedPath
    throw error
  }
}

/**
 * Serializes mutations of the same file (resolved through symlinks).
 * Mutations of different files still run in parallel.
 */
export function withFileMutationQueue<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return enqueueMutation(filePath, fn)
}

/** @internal Queue a mutation by its environment namespace and canonical path. */
export function withEnvironmentMutationQueue<T>(
  filePath: string,
  fn: () => Promise<T>,
  env: ExecutionEnv,
  signal?: AbortSignal,
): Promise<T> {
  return enqueueMutation(filePath, fn, env, signal)
}

async function enqueueMutation<T>(
  filePath: string,
  fn: () => Promise<T>,
  env?: ExecutionEnv,
  signal?: AbortSignal,
): Promise<T> {
  const registration = registrationQueue.then(async () => {
    let key: string
    if (env) {
      const result = await env.canonicalPath(filePath, signal)
      if (!result.ok && result.error.code !== 'not_found') throw result.error
      key = `${env.id}:${result.ok ? result.value : filePath}`
    } else key = `node:local:${await getMutationQueueKey(filePath)}`
    const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve()

    let releaseNext!: () => void
    const nextQueue = new Promise<void>((resolveQueue) => {
      releaseNext = resolveQueue
    })
    const chainedQueue = currentQueue.then(() => nextQueue)
    fileMutationQueues.set(key, chainedQueue)

    return { key, currentQueue, chainedQueue, releaseNext }
  })
  registrationQueue = registration.then(
    () => undefined,
    () => undefined,
  )

  const { key, currentQueue, chainedQueue, releaseNext } = await registration
  await currentQueue
  try {
    return await fn()
  } finally {
    releaseNext()
    if (fileMutationQueues.get(key) === chainedQueue)
      fileMutationQueues.delete(key)
  }
}
