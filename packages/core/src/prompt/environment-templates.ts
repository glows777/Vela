import type { ExecutionEnv } from '../execution/types.ts'
import { type PromptTemplate, parseTemplate } from './template-definition.ts'

/** Read workspace and declared templates from the selected execution environment. */
export async function loadEnvironmentTemplates(
  env: ExecutionEnv,
  cwd: string,
  signal?: AbortSignal,
  declaredPaths: readonly string[] = [],
): Promise<PromptTemplate[]> {
  const root = await env.joinPath([cwd, '.vela', 'prompts'], signal)
  if (!root.ok) throw root.error
  const templates = new Map<string, PromptTemplate>()
  const add = async (path: string, name: string) => {
    if (!name.endsWith('.md')) return
    const source = await env.readTextFile(path, signal)
    if (!source.ok) {
      if (source.error.code === 'not_found') return
      throw source.error
    }
    try {
      const template = parseTemplate(name.slice(0, -3), path, source.value)
      if (!templates.has(template.name)) templates.set(template.name, template)
    } catch {
      // Invalid frontmatter skips only this template.
    }
  }
  for (const path of [root.value, ...declaredPaths]) {
    const real = await env.canonicalPath(path, signal)
    if (!real.ok) {
      if (real.error.code === 'not_found') continue
      throw real.error
    }
    const info = await env.fileInfo(real.value, signal)
    if (!info.ok) {
      if (info.error.code === 'not_found') continue
      throw info.error
    }
    if (info.value.kind === 'file') {
      await add(path, path.split(/[\\/]/).at(-1) ?? '')
      continue
    }
    if (info.value.kind !== 'directory') continue
    const entries = await env.listDir(path, signal)
    if (!entries.ok) {
      if (entries.error.code === 'not_found') continue
      throw entries.error
    }
    for (const entry of entries.value
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        !entry.name.endsWith('.md') ||
        (entry.kind !== 'file' && entry.kind !== 'symlink')
      )
        continue
      const file = await env.joinPath([path, entry.name], signal)
      if (!file.ok) throw file.error
      if (entry.kind === 'symlink') {
        const target = await env.canonicalPath(file.value, signal)
        if (!target.ok) {
          if (target.error.code === 'not_found') continue
          throw target.error
        }
        const targetInfo = await env.fileInfo(target.value, signal)
        if (!targetInfo.ok) throw targetInfo.error
        if (targetInfo.value.kind !== 'file') continue
      }
      await add(file.value, entry.name)
    }
  }
  return [...templates.values()]
}
