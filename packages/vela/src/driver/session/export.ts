import { existsSync, realpathSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { openDatabase } from '../../db/index.ts'
import type { ModelInput } from '../../shared/provider-types.ts'
import type { ExecutionLocation } from '../execution/types.ts'
import {
  loadSessionMeta,
  parseRowLocation,
  queryBranchRows,
  rowToEntry,
} from './db-store.ts'
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
  channel?: string,
  parentSession?: string,
): string {
  const header: SessionHeader = {
    type: 'session',
    version: SESSION_FORMAT_VERSION,
    id: id,
    timestamp: new Date().toISOString(),
    cwd: location.cwd,
    location,
    ...(channel ? { channel } : {}),
    ...(parentSession ? { parentSession } : {}),
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
  model?: ModelInput
  channel?: string
  parentSession?: string
  format: 'jsonl' | 'html'
}): Promise<string> {
  const content =
    options.format === 'jsonl'
      ? branchJsonl(
          options.id,
          options.location,
          options.entries,
          options.channel,
          options.parentSession,
        )
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

function canonicalPath(path: string): string {
  const abs = resolve(path)
  if (existsSync(abs)) return realpathSync(abs)
  const suffix: string[] = []
  let cur = abs
  while (!existsSync(cur)) {
    const parent = dirname(cur)
    if (parent === cur) return abs
    suffix.unshift(basename(cur))
    cur = parent
  }
  return join(realpathSync(cur), ...suffix)
}

function assertSafeExportTarget(
  dbPath: string,
  baseCwd: string,
  outputPath: string | undefined,
): void {
  if (!outputPath) return
  const target = resolve(baseCwd, outputPath)
  const canonicalTarget = canonicalPath(target)
  const targetStat = existsSync(target) ? statSync(target) : undefined
  const protectedPaths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
  for (const reserved of protectedPaths) {
    if (
      target === resolve(reserved) ||
      canonicalTarget === canonicalPath(reserved)
    ) {
      throw new Error(`Refusing to overwrite database file: ${target}`)
    }
    if (targetStat && existsSync(reserved)) {
      const reservedStat = statSync(reserved)
      if (
        targetStat.dev === reservedStat.dev &&
        targetStat.ino === reservedStat.ino
      ) {
        throw new Error(`Refusing to overwrite database file: ${target}`)
      }
    }
  }
}

/** Exports a saved session directly from `vela.db` in read-only mode without starting extensions or models. */
export async function exportSavedSession(options: {
  dataDir: string
  agentDir?: string
  sessionId: string
  outputPath?: string
  baseCwd: string
}): Promise<string> {
  const dbRoot = options.agentDir ?? options.dataDir
  const dbPath = join(dbRoot, 'vela.db')
  if (!existsSync(dbPath)) {
    throw new Error(
      `Session ${options.sessionId} has no saved history in vela.db`,
    )
  }
  assertSafeExportTarget(dbPath, options.baseCwd, options.outputPath)
  const db = openDatabase({ path: dbPath, readonly: true })
  try {
    const meta = loadSessionMeta(db, options.sessionId)
    if (!meta.row) {
      throw new Error(
        `Session ${options.sessionId} has no saved history in vela.db`,
      )
    }
    const rows = queryBranchRows(
      db,
      options.sessionId,
      meta.row.leaf_message_id,
    )
    const location: ExecutionLocation = parseRowLocation(
      meta.row.location_json,
    ) ?? {
      environment: 'local',
      cwd: options.baseCwd,
    }
    const format = options.outputPath?.toLowerCase().endsWith('.jsonl')
      ? 'jsonl'
      : 'html'
    return await exportBranch({
      id: options.sessionId,
      baseCwd: options.baseCwd,
      location,
      path: options.outputPath,
      entries: rows.map(rowToEntry),
      name: meta.row.name ?? undefined,
      model: meta.model,
      channel: meta.channel,
      parentSession: meta.row.parent_session_id ?? undefined,
      format,
    })
  } finally {
    if (db.open) db.close()
  }
}
