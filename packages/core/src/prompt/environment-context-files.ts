import { followFileInfo } from '../execution/file-info.ts'
import type { ExecutionEnv, FileError, Result } from '../execution/types.ts'
import type { ContextFile } from './context-files.ts'

const NAMES = [
  'AGENTS.override.md',
  'AGENTS.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD',
]
const value = <T>(result: Result<T, FileError>): T => {
  if (!result.ok) throw result.error
  return result.value
}

/** Discover workspace instructions using the selected filesystem, preserving root-to-cwd order. */
export async function loadEnvironmentContextFiles(
  env: ExecutionEnv,
  cwd: string,
  signal?: AbortSignal,
): Promise<ContextFile[]> {
  const join = async (...parts: string[]) =>
    value(await env.joinPath(parts, signal))
  const parent = (path: string) => join(path, '..')
  const canonical = async (path: string) => {
    const result = await env.canonicalPath(path, signal)
    if (result.ok) return result.value
    if (result.error.code === 'not_found') return path
    throw result.error
  }
  const fromDir = async (dir: string): Promise<ContextFile | undefined> => {
    for (const name of NAMES) {
      const path = await join(dir, name)
      const info = await followFileInfo(env, path, signal)
      if (!info.ok) {
        if (info.error.code === 'not_found') continue
        throw info.error
      }
      if (info.value.kind !== 'file') continue
      const text = await env.readTextFile(path, signal)
      if (!text.ok) throw text.error
      return { path, content: text.value.replace(/^\uFEFF/, '') }
    }
  }
  const ancestors: string[] = []
  for (let current = cwd; ; ) {
    signal?.throwIfAborted()
    ancestors.unshift(current)
    const next = await parent(current)
    if (next === current) break
    current = next
  }
  // A nested linked worktree's own instructions shadow the main checkout's file.
  let shadowed: string | undefined
  for (const dir of [...ancestors].reverse()) {
    const git = await join(dir, '.git')
    const info = await env.fileInfo(git, signal)
    if (!info.ok) {
      if (info.error.code === 'not_found') continue
      throw info.error
    }
    if (info.value.kind !== 'file') break
    const file = await env.readTextFile(git, signal)
    if (!file.ok || !file.value.trim().startsWith('gitdir: ')) break
    const gitRef = file.value.trim().slice(8).trim()
    const absolute = (path: string) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path)
    const gitDir = absolute(gitRef) ? gitRef : await join(dir, gitRef)
    const commonFile = await join(gitDir, 'commondir')
    const commonText = await env.readTextFile(commonFile, signal)
    const commonRef = commonText.ok ? commonText.value.trim() : undefined
    if (!commonText.ok && commonText.error.code !== 'not_found')
      throw commonText.error
    const common = await canonical(
      commonRef
        ? absolute(commonRef)
          ? commonRef
          : await join(gitDir, commonRef)
        : gitDir,
    )
    const mainRoot = await parent(common)
    const checkout = await canonical(dir)
    const normalized = (path: string) => path.replaceAll('\\', '/')
    if (
      !normalized(checkout).startsWith(
        `${normalized(mainRoot).replace(/\/$/, '')}/`,
      )
    )
      break
    if ((await canonical(await join(mainRoot, '.git'))) !== common) break
    const own = await fromDir(dir)
    if (own)
      shadowed = await canonical(
        await join(mainRoot, own.path.replaceAll('\\', '/').split('/').at(-1)!),
      )
    break
  }
  const files: ContextFile[] = []
  for (const dir of ancestors) {
    const file = await fromDir(dir)
    if (file && (!shadowed || (await canonical(file.path)) !== shadowed))
      files.push(file)
  }
  return files
}
