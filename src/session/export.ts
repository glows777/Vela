import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  SESSION_FORMAT_VERSION,
  type SessionEntry,
  type SessionHeader,
} from './entries.ts'

/** The current branch as JSONL lines (like pi's exportToJsonl): a header, then the entries re-chained. */
export function branchJsonl(
  id: string,
  cwd: string,
  entries: SessionEntry[],
): string {
  const header: SessionHeader = {
    type: 'session',
    version: SESSION_FORMAT_VERSION,
    id: id,
    timestamp: new Date().toISOString(),
    cwd: cwd,
  }
  const lines: object[] = [header]
  let parentId: string | null = null
  for (const entry of entries) {
    lines.push({ ...entry, parentId })
    parentId = entry.id
  }
  return lines.map((line) => `${JSON.stringify(line)}\n`).join('')
}

export async function writeExport(
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
