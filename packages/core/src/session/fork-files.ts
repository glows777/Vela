import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import type { SessionEntry } from './entries.ts'
import type { ToolResultStore } from './tool-results.ts'

const RESULT_FILE =
  /^(?:vela-(?:output|result|micro)-)?[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.(?:txt|log)/i

function replacePaths(text: string, pairs: [string, string][]): string {
  return pairs.reduce(
    (out, [from, to]) => (from && from !== to ? out.replaceAll(from, to) : out),
    text,
  )
}

function rewritePaths<T>(value: T, pairs: [string, string][]): T {
  if (typeof value === 'string') return replacePaths(value, pairs) as T
  if (Array.isArray(value))
    return value.map((item) => rewritePaths(item, pairs)) as T
  if (value && typeof value === 'object') {
    const copy: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value))
      copy[key] = rewritePaths(item, pairs)
    return copy as T
  }
  return value
}

function referencedResultFiles(text: string, dir: string): string[] {
  const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`
  const found = new Set<string>()
  let from = 0
  while (from < text.length) {
    const at = text.indexOf(prefix, from)
    if (at < 0) break
    const match = RESULT_FILE.exec(text.slice(at + prefix.length))
    if (match) found.add(prefix + match[0])
    from = at + prefix.length
  }
  return [...found]
}

export async function inheritToolResultPaths(
  entries: SessionEntry[],
  parent: ToolResultStore,
  childDir: string,
  childHistoryPath: string,
  historyText: string | undefined,
  historyFile: string,
  uploads: [string, string][],
): Promise<SessionEntry[]> {
  const blob = `${JSON.stringify(entries)}\n${historyText ?? ''}`
  const files = referencedResultFiles(blob, parent.dir)
  if (files.length) await mkdir(childDir, { recursive: true, mode: 0o700 })
  for (const file of files) {
    try {
      await copyFile(file, join(childDir, basename(file)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const pairs: [string, string][] = [
    ...uploads,
    [parent.history.path, childHistoryPath],
    [
      join(dirname(parent.history.path), 'snapshots'),
      join(dirname(childHistoryPath), 'snapshots'),
    ],
    [parent.dir, childDir],
  ]
  if (historyText !== undefined) {
    const rewritten = replacePaths(historyText, pairs)
    if (rewritten !== historyText)
      await writeFile(historyFile, rewritten, { mode: 0o600 })
  }
  return rewritePaths(entries, pairs)
}
