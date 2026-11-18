import type { ExecutionEnv } from '../execution/types.ts'
import { parseFrontmatter } from './frontmatter.ts'
import type { PromptTemplate } from './templates.ts'

/** Read workspace templates from the selected execution environment. */
export async function loadEnvironmentTemplates(
  env: ExecutionEnv,
  cwd: string,
  signal?: AbortSignal,
): Promise<PromptTemplate[]> {
  const path = await env.joinPath([cwd, '.vela', 'prompts'], signal)
  if (!path.ok) throw path.error
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
    if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue
    const file = await env.joinPath([path.value, entry.name], signal)
    if (!file.ok) throw file.error
    const source = await env.readTextFile(file.value, signal)
    if (!source.ok) throw source.error
    let data: ReturnType<typeof parseFrontmatter>
    try {
      data = parseFrontmatter(source.value)
    } catch {
      continue
    }
    let description =
      typeof data.frontmatter.description === 'string'
        ? data.frontmatter.description
        : ''
    if (!description) {
      const line = data.body.split('\n').find((item) => item.trim())
      if (line)
        description = line.length > 60 ? `${line.slice(0, 60)}...` : line
    }
    const hint = data.frontmatter['argument-hint']
    templates.push({
      name: entry.name.slice(0, -3),
      description,
      ...(typeof hint === 'string' && hint ? { argumentHint: hint } : {}),
      content: data.body,
      filePath: file.value,
    })
  }
  return templates
}
