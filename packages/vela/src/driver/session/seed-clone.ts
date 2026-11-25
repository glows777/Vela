import { randomUUID } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from 'node:fs'
import { basename, join, sep } from 'node:path'
import type { VelaDatabase } from '../../db/index.ts'
import type { ExecutionEnv } from '../execution/types.ts'
import { copyBranch, entriesToMessages, type SessionEntry } from './entries.ts'
import { pendingToolCalls } from './recovery.ts'
import type { SessionUploads } from './uploads.ts'

const MAX_REMOTE_SPILL_COPY_BYTES = 20 * 1024 * 1024
const TERMINAL_TOOL_STATUSES = new Set([
  'completed',
  'failed',
  'skipped',
  'interrupted',
])

type ClonedToolCallRow = {
  run_id: string
  assistant_message_id: string
  tool_call_id: string
  call_index: number
  tool_name: string
  input_json: string
  execution_mode: string
  replay: string
  location_json: string | null
  status: string
  attempt: number
  is_error: number
  preview: string | null
  result_json: string | null
  spill_path: string | null
  details_json: string | null
  duration_ms: number | null
  started_at: string | null
  finished_at: string | null
  created_at: string
  updated_at: string
}

export interface PreparedSeedBranch {
  entries: SessionEntry[]
  parentCalls: ClonedToolCallRow[]
  rewrites: [string, string][]
  spillRewrites: Map<string, string>
}

export async function prepareSeedBranch(params: {
  db: VelaDatabase
  branch: SessionEntry[]
  parentId: string
  parentUploads: SessionUploads
  targetUploads: SessionUploads
  resolveEnv: () => Promise<ExecutionEnv>
  isRemote?: boolean
  parentSpillDir?: string
  spillDir?: string
}): Promise<PreparedSeedBranch> {
  const { db, branch, parentId, parentUploads, targetUploads, resolveEnv } =
    params
  if (pendingToolCalls(entriesToMessages(branch)).length > 0) {
    throw new Error('Cannot fork or clone through unresolved tool calls')
  }
  const branchIds = new Set(branch.map((entry) => entry.id))
  const parentCalls = branchIds.size
    ? db
        .all<ClonedToolCallRow>(
          'SELECT run_id, assistant_message_id, tool_call_id, call_index, tool_name, input_json, execution_mode, replay, location_json, status, attempt, is_error, preview, result_json, spill_path, details_json, duration_ms, started_at, finished_at, created_at, updated_at FROM vela_tool_calls WHERE session_id = ?',
          parentId,
        )
        .filter((row) => branchIds.has(row.assistant_message_id))
    : []
  if (parentCalls.some((row) => !TERMINAL_TOOL_STATUSES.has(row.status))) {
    throw new Error(
      'Cannot fork or clone through unresolved or awaiting-approval tool calls',
    )
  }

  const rewrites = await targetUploads.inherit(
    parentUploads,
    branch,
    resolveEnv,
  )

  const spillRewrites = new Map<string, string>()
  const targetSpillDir = params.spillDir
  const realParentSpillDir =
    params.parentSpillDir && existsSync(params.parentSpillDir)
      ? realpathSync(params.parentSpillDir)
      : undefined
  let remoteEnv: ExecutionEnv | undefined
  const copyLocalConfinedSpill = (sourcePath: string): boolean => {
    if (!targetSpillDir || !realParentSpillDir) return false
    if (targetSpillDir === params.parentSpillDir) return true
    if (!existsSync(sourcePath)) return false
    let realSource: string
    try {
      realSource = realpathSync(sourcePath)
    } catch {
      return false
    }
    if (!realSource.startsWith(realParentSpillDir + sep)) return false
    let fd: number | undefined
    try {
      fd = openSync(realSource, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      if (!fstatSync(fd).isFile()) return false
    } catch {
      return false
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    mkdirSync(targetSpillDir, { recursive: true })
    let dest = join(targetSpillDir, basename(sourcePath))
    if (existsSync(dest)) {
      dest = join(
        targetSpillDir,
        `${randomUUID().slice(0, 8)}-${basename(sourcePath)}`,
      )
    }
    copyFileSync(realSource, dest)
    spillRewrites.set(sourcePath, dest)
    rewrites.push([sourcePath, dest])
    return true
  }
  const copyRemoteSpill = async (sourcePath: string) => {
    remoteEnv ??= await resolveEnv()
    if (remoteEnv.id === 'node:local') return
    const opened = await remoteEnv.openBinaryReader(sourcePath, {
      noFollow: true,
    })
    if (!opened.ok) return
    const reader = opened.value
    try {
      const info = await reader.info()
      if (!info.ok || info.value.kind !== 'file') return
      if (info.value.size > MAX_REMOTE_SPILL_COPY_BYTES) return
      const read = await reader.read(0, info.value.size)
      if (!read.ok) return
      const temp = await remoteEnv.createTempFile({
        prefix: 'vela-result-',
        suffix: '.txt',
      })
      if (!temp.ok) return
      const written = await remoteEnv.writeFile(temp.value, read.value)
      if (!written.ok) {
        await remoteEnv.remove(temp.value, { force: true }).catch(() => {})
        return
      }
      spillRewrites.set(sourcePath, temp.value)
      rewrites.push([sourcePath, temp.value])
    } finally {
      await reader.close()
    }
  }
  const copySpillFile = async (sourcePath: string | undefined) => {
    if (!sourcePath || spillRewrites.has(sourcePath)) return
    if (params.isRemote) {
      await copyRemoteSpill(sourcePath)
      return
    }
    copyLocalConfinedSpill(sourcePath)
  }
  for (const row of parentCalls) {
    await copySpillFile(row.spill_path ?? undefined)
  }
  for (const entry of branch) {
    if (entry.type === 'bash_execution') {
      await copySpillFile(entry.fullOutputPath)
    }
  }

  const cloned = structuredClone(branch)
  if (rewrites.length) rewriteEntryStrings(cloned, rewrites)
  return {
    entries: copyBranch(cloned),
    parentCalls,
    rewrites,
    spillRewrites,
  }
}

export function insertClonedToolCalls(
  db: VelaDatabase,
  sessionId: string,
  modelName: string | undefined,
  prepared: PreparedSeedBranch,
): void {
  const { parentCalls, rewrites, spillRewrites } = prepared
  if (!parentCalls.length) return
  const now = new Date().toISOString()
  const runIdMap = new Map<string, string>()
  for (const row of parentCalls) {
    let clonedRunId = runIdMap.get(row.run_id)
    if (!clonedRunId) {
      clonedRunId = randomUUID()
      runIdMap.set(row.run_id, clonedRunId)
      db.run(
        `INSERT INTO runs (
           id, session_id, project_id, driver, trigger, status, model, started_at, finished_at, updated_at
         ) VALUES (?, ?, NULL, 'vela', 'session', 'completed', ?, ?, ?, ?)`,
        clonedRunId,
        sessionId,
        modelName ?? null,
        now,
        now,
        now,
      )
    }
    const rewrittenSpill =
      row.spill_path && spillRewrites.has(row.spill_path)
        ? spillRewrites.get(row.spill_path)!
        : row.spill_path
    db.run(
      `INSERT INTO vela_tool_calls (
         id, session_id, run_id, assistant_message_id, tool_call_id, call_index,
         tool_name, input_json, execution_mode, replay, location_json, status, attempt,
         is_error, preview, result_json, spill_path, details_json, duration_ms,
         started_at, finished_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(),
      sessionId,
      clonedRunId,
      row.assistant_message_id,
      row.tool_call_id,
      row.call_index,
      row.tool_name,
      rewrites.length ? rewriteText(row.input_json, rewrites) : row.input_json,
      row.execution_mode,
      row.replay,
      row.location_json,
      row.status,
      row.attempt,
      row.is_error,
      row.preview !== null && rewrites.length
        ? rewriteText(row.preview, rewrites)
        : row.preview,
      row.result_json !== null && rewrites.length
        ? rewriteText(row.result_json, rewrites)
        : row.result_json,
      rewrittenSpill,
      row.details_json,
      row.duration_ms,
      row.started_at,
      row.finished_at,
      row.created_at,
      now,
    )
  }
}

function rewriteText(
  text: string,
  rewrites: readonly [string, string][],
): string {
  let out = text
  for (const [from, to] of rewrites) {
    if (out.includes(from)) out = out.replaceAll(from, to)
  }
  return out
}

function rewriteEntryStrings(
  entries: SessionEntry[],
  rewrites: readonly [string, string][],
): void {
  for (const entry of entries) {
    if (entry.type === 'message') {
      const { content } = entry.message
      if (typeof content === 'string') {
        entry.message.content = rewriteText(content, rewrites)
      } else {
        for (const part of content) {
          if ('text' in part && typeof part.text === 'string') {
            part.text = rewriteText(part.text, rewrites)
          } else if (part.type === 'tool_result') {
            if (
              (part.output.type === 'text' ||
                part.output.type === 'error-text') &&
              typeof part.output.value === 'string'
            ) {
              part.output.value = rewriteText(part.output.value, rewrites)
            } else if (part.output.type === 'content') {
              for (const item of part.output.value) {
                if (item.type === 'text' && typeof item.text === 'string') {
                  item.text = rewriteText(item.text, rewrites)
                }
              }
            }
          }
        }
      }
    } else if (entry.type === 'bash_execution') {
      entry.output = rewriteText(entry.output, rewrites)
      if (entry.fullOutputPath) {
        entry.fullOutputPath = rewriteText(entry.fullOutputPath, rewrites)
      }
    } else if (entry.type === 'custom_message') {
      if (typeof entry.content === 'string') {
        entry.content = rewriteText(entry.content, rewrites)
      } else {
        for (const part of entry.content) {
          if (part.type === 'text') {
            part.text = rewriteText(part.text, rewrites)
          }
        }
      }
    } else if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      entry.summary = rewriteText(entry.summary, rewrites)
    }
  }
}
