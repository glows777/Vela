import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { LanguageModel } from 'ai'
import type { ExecutionLocation } from '../execution/types.ts'
import {
  SESSION_FORMAT_VERSION,
  type SessionEntry,
  type SessionHeader,
} from './entries.ts'
import { renderSessionHtml } from './export-html.ts'

/** The current branch as JSONL lines (like pi's exportToJsonl): a header, then the entries re-chained. */
function branchJsonl(
  id: string,
  location: ExecutionLocation,
  entries: SessionEntry[],
): string {
  const header: SessionHeader = {
    type: 'session',
    version: SESSION_FORMAT_VERSION,
    id: id,
    timestamp: new Date().toISOString(),
    cwd: location.cwd,
    location,
  }
  const lines: object[] = [header]
  let parentId: string | null = null
  for (const entry of entries) {
    lines.push({ ...entry, parentId })
    parentId = entry.id
  }
  return lines.map((line) => `${JSON.stringify(line)}\n`).join('')
}

async function writeExport(
  id: string,
  cwd: string | undefined,
  path: string | undefined,
  extension: string,
  content: string,
): Promise<string> {
  const target = resolve(
    cwd ?? process.cwd(),
    path ??
      `vela-session-${id}-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`,
  )
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, { mode: 0o600 })
  return target
}

/** Exports the current branch to one self-contained file. */
export function exportBranch(options: {
  id: string
  baseCwd?: string
  location: ExecutionLocation
  path?: string
  entries: SessionEntry[]
  name?: string
  model?: string | LanguageModel
  format: 'jsonl' | 'html'
}): Promise<string> {
  const content =
    options.format === 'jsonl'
      ? branchJsonl(options.id, options.location, options.entries)
      : renderSessionHtml({
          id: options.id,
          name: options.name,
          model: options.model,
          entries: options.entries,
        })
  return writeExport(
    options.id,
    options.baseCwd,
    options.path,
    options.format,
    content,
  )
}
