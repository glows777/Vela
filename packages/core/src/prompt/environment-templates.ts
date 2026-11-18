import type { ExecutionEnv } from '../execution/types.ts'
import { type PromptTemplate, parseTemplate } from './template-definition.ts'

/** Read workspace templates from the selected execution environment. */
export async function loadEnvironmentTemplates(
  env: ExecutionEnv,
  cwd: string,
  signal?: AbortSignal,
): Promise<PromptTemplate[]> {
  const path = await env.joinPath([cwd, '.vela', 'prompts'], signal)
  if (!path.ok) throw path.error
  const info = await env.fileInfo(path.value, signal)
  if (!info.ok) {
    if (info.error.code === 'not_found') return []
    throw info.error
  }
  if (info.value.kind !== 'directory' && info.value.kind !== 'symlink')
    return []
  const entries = await env.listDir(path.value, signal)
  if (!entries.ok) {
    if (
      entries.error.code === 'not_found' ||
      entries.error.code === 'not_directory'
    )
      return []
    throw entries.error
  }
  const templates: PromptTemplate[] = []
  for (const entry of entries.value
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (
      !entry.name.endsWith('.md') ||
      (entry.kind !== 'file' && entry.kind !== 'symlink')
    )
      continue
    const file = await env.joinPath([path.value, entry.name], signal)
    if (!file.ok) throw file.error
    if (entry.kind === 'symlink') {
      const target = await env.canonicalPath(file.value, signal)
      if (!target.ok) {
        if (target.error.code === 'not_found') continue
        throw target.error
      }
      const info = await env.fileInfo(target.value, signal)
      if (!info.ok) throw info.error
      if (info.value.kind !== 'file') continue
    }
    const source = await env.readTextFile(file.value, signal)
    if (!source.ok) throw source.error
    try {
      templates.push(
        parseTemplate(entry.name.slice(0, -3), file.value, source.value),
      )
    } catch {
      // Invalid frontmatter skips only this template.
    }
  }
  return templates
}
