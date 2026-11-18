import type { ExecutionEnv } from './types.ts'

/** fileInfo reports the entry itself. These callers need the target type. */
export async function followFileInfo(
  env: ExecutionEnv,
  path: string,
  signal?: AbortSignal,
) {
  const info = await env.fileInfo(path, signal)
  if (!info.ok || info.value.kind !== 'symlink') return info
  const target = await env.canonicalPath(path, signal)
  if (!target.ok) return target
  return env.fileInfo(target.value, signal)
}
