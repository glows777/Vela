import type { ExecutionEnv, FileError, Result } from '../execution/types.ts'
import { parseFrontmatter } from '../prompt/frontmatter.ts'
import type { SkillDefinition } from './loader.ts'

const unwrap = <T>(result: Result<T, FileError>): T => {
  if (!result.ok) throw result.error
  return result.value
}

/** Read a session's workspace skills without consulting the host filesystem. */
export async function loadEnvironmentSkills(
  env: ExecutionEnv,
  cwd: string,
  signal?: AbortSignal,
): Promise<SkillDefinition[]> {
  const join = async (...parts: string[]) =>
    unwrap(await env.joinPath(parts, signal))
  const found = new Map<string, SkillDefinition>()
  const visited = new Set<string>()
  const scan = async (dir: string, rootFiles: boolean): Promise<void> => {
    signal?.throwIfAborted()
    const canonical = await env.canonicalPath(dir, signal)
    if (!canonical.ok) {
      if (canonical.error.code === 'not_found') return
      throw canonical.error
    }
    if (visited.has(canonical.value)) return
    visited.add(canonical.value)
    const entries = await env.listDir(dir, signal)
    if (!entries.ok) {
      if (
        entries.error.code === 'not_found' ||
        entries.error.code === 'not_directory'
      )
        return
      throw entries.error
    }
    const add = async (filePath: string) => {
      const content = await env.readTextFile(filePath, signal)
      if (!content.ok) throw content.error
      const { frontmatter } = parseFrontmatter(content.value)
      const description =
        typeof frontmatter.description === 'string'
          ? frontmatter.description.trim()
          : ''
      if (!description) return
      const parts = filePath.replaceAll('\\', '/').split('/')
      const filename = parts.at(-1)!
      const baseDir = filePath
        .slice(0, filePath.length - filename.length)
        .replace(/[\\/]$/, '')
      const fallback =
        filename === 'SKILL.md' ? parts.at(-2)! : filename.slice(0, -3)
      const name =
        typeof frontmatter.name === 'string' && frontmatter.name
          ? frontmatter.name
          : fallback
      if (!found.has(name))
        found.set(name, {
          name,
          description,
          filePath,
          baseDir,
          disableModelInvocation:
            frontmatter['disable-model-invocation'] === true,
        })
    }
    const ordered = entries.value
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
    const declared = ordered.find(
      (entry) => entry.name === 'SKILL.md' && entry.kind === 'file',
    )
    if (declared) {
      await add(await join(dir, declared.name))
      return
    }
    for (const entry of ordered) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const file = await join(dir, entry.name)
      if (entry.kind === 'directory') await scan(file, false)
      else if (rootFiles && entry.kind === 'file' && entry.name.endsWith('.md'))
        await add(file)
    }
  }
  await scan(await join(cwd, '.vela', 'skills'), true)
  await scan(await join(cwd, '.skills'), true)
  return [...found.values()]
}
