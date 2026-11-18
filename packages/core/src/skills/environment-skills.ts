import type { ExecutionEnv, FileError, Result } from '../execution/types.ts'
import { parseFrontmatter } from '../prompt/frontmatter.ts'
import { parseSkill } from './definition.ts'
import type { ResourceDiagnostic, SkillDefinition } from './loader.ts'

const unwrap = <T>(result: Result<T, FileError>): T => {
  if (!result.ok) throw result.error
  return result.value
}

/** Read a session's workspace skills without consulting the host filesystem. */
export async function loadEnvironmentSkills(
  env: ExecutionEnv,
  cwd: string,
  signal: AbortSignal | undefined,
  homeSkillsOnly: boolean,
  report: (problem: ResourceDiagnostic) => void,
): Promise<SkillDefinition[]> {
  const join = async (...parts: string[]) =>
    unwrap(await env.joinPath(parts, signal))
  const skip = (error: FileError, path: string) => {
    if (error.code === 'aborted' || error.code === 'unavailable') throw error
    if (error.code !== 'not_found' && error.code !== 'not_directory')
      report({ path, message: error.message })
  }
  const found = new Map<string, SkillDefinition>()
  const visited = new Set<string>()
  const seenFiles = new Set<string>()
  const scan = async (dir: string, rootFiles: boolean): Promise<void> => {
    signal?.throwIfAborted()
    const canonical = await env.canonicalPath(dir, signal)
    if (!canonical.ok) return skip(canonical.error, dir)
    if (visited.has(canonical.value)) return
    visited.add(canonical.value)
    const entries = await env.listDir(dir, signal)
    if (!entries.ok) return skip(entries.error, dir)
    const add = async (filePath: string) => {
      const real = await env.canonicalPath(filePath, signal)
      if (!real.ok) return skip(real.error, filePath)
      if (seenFiles.has(real.value)) return
      const content = await env.readTextFile(filePath, signal)
      if (!content.ok) return skip(content.error, filePath)
      const skill = parseSkill(filePath, content.value, report)
      if (!skill) return
      const existing = found.get(skill.name)
      if (!existing) {
        seenFiles.add(real.value)
        found.set(skill.name, skill)
      } else
        report({
          path: filePath,
          message: `skill name "${skill.name}" is already used by ${existing.filePath}; skipped`,
        })
    }
    const ordered = entries.value
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
    const kind = async (entry: (typeof ordered)[number]) => {
      if (entry.kind !== 'symlink') return entry.kind
      const path = await join(dir, entry.name)
      const target = await env.canonicalPath(path, signal)
      if (!target.ok) {
        skip(target.error, path)
        return
      }
      const info = await env.fileInfo(target.value, signal)
      if (!info.ok) {
        skip(info.error, path)
        return
      }
      return info.value.kind
    }
    const declared = ordered.find((entry) => entry.name === 'SKILL.md')
    if (declared && (await kind(declared)) === 'file') {
      await add(await join(dir, declared.name))
      return
    }
    for (const entry of ordered) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const file = await join(dir, entry.name)
      const entryKind = await kind(entry)
      if (entryKind === 'directory') await scan(file, false)
      else if (rootFiles && entryKind === 'file' && entry.name.endsWith('.md'))
        await add(file)
    }
  }
  if (homeSkillsOnly) {
    await scan(await join(cwd, '.skills'), true)
    return [...found.values()]
  }
  await scan(await join(cwd, '.vela', 'skills'), true)
  let current = cwd
  while (true) {
    await scan(await join(current, '.agents', 'skills'), true)
    const git = await env.fileInfo(await join(current, '.git'), signal)
    if (git.ok) break
    if (git.error.code !== 'not_found') {
      skip(git.error, current)
      break
    }
    const parent = await join(current, '..')
    if (parent === current) break
    current = parent
  }
  await scan(await join(cwd, '.skills'), true)
  return [...found.values()]
}

/** Expand a workspace skill through the selected environment. */
export async function expandEnvironmentSkill(
  text: string,
  skills: readonly SkillDefinition[],
  env: ExecutionEnv,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!text.startsWith('/skill:')) return
  const space = text.search(/\s/)
  const name = space === -1 ? text.slice(7) : text.slice(7, space)
  const skill = skills.find((item) => item.name === name)
  if (!skill) return
  const content = await env.readTextFile(skill.filePath, signal)
  if (!content.ok)
    throw new Error(
      `Could not load skill ${name} from ${skill.filePath}: ${content.error.message}`,
    )
  const body = parseFrontmatter(content.value).body
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`
  const args = space === -1 ? '' : text.slice(space + 1).trim()
  return args ? `${block}\n\n${args}` : block
}
