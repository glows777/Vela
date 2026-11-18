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

// A new file can have missing parents below a directory symlink. Use its
// nearest existing ancestor so the queue and write guard keep the same key
// before and after the file is created.
async function canonicalMutationPath(
  env: ExecutionEnv,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  let ancestor = path
  while (true) {
    const resolved = await env.canonicalPath(ancestor, signal)
    if (resolved.ok) {
      if (ancestor === path) return resolved.value
      if (ancestor === resolved.value) return path
      const suffix = path.slice(ancestor.length).replace(/^[/\\]/, '')
      const target = await env.joinPath([resolved.value, suffix], signal)
      if (!target.ok) throw target.error
      return target.value
    }
    if (resolved.error.code === 'not_directory') return path
    if (resolved.error.code !== 'not_found') throw resolved.error
    const parent = await env.joinPath([ancestor, '..'], signal)
    if (!parent.ok) throw parent.error
    if (parent.value === ancestor) throw resolved.error
    ancestor = parent.value
  }
}

/** @internal Queue a mutation by its environment namespace and canonical path. */
export async function withEnvironmentMutationQueue<T>(
  filePath: string,
  fn: (canonicalPath: string) => Promise<T>,
  env: ExecutionEnv,
  signal?: AbortSignal,
): Promise<T> {
  const registration = registrationQueue.then(async () => {
    const canonical = await canonicalMutationPath(env, filePath, signal)
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
