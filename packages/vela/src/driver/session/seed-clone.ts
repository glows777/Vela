import { randomUUID } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, sep } from 'node:path'
import type { VelaDatabase } from '../../db/index.ts'
import type { ExecutionEnv, ExecutionLocation } from '../execution/types.ts'
import { parseRowLocation } from './db-store.ts'
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

type ClonedMessageUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  costUsd?: number
  durationMs?: number
}

export interface PreparedSeedBranch {
  entries: SessionEntry[]
  parentCalls: ClonedToolCallRow[]
  messageUsage: Map<string, ClonedMessageUsage>
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
  resolveSourceEnv?: (location?: ExecutionLocation) => Promise<ExecutionEnv>
  parentLocation?: ExecutionLocation
  targetLocation?: ExecutionLocation
  entryLocations?: ReadonlyMap<string, ExecutionLocation>
  parentSpillDir?: string
  spillDir?: string
}): Promise<PreparedSeedBranch> {
  const { db, branch, parentId, parentUploads, targetUploads, resolveEnv } =
    params
  if (pendingToolCalls(entriesToMessages(branch)).length > 0) {
    throw new Error('Cannot fork or clone through unresolved tool calls')
  }
  const branchIds = new Set(branch.map((entry) => entry.id))
  const messageUsage = new Map<string, ClonedMessageUsage>()
  if (branchIds.size) {
    const usageRows = db.all<{
      id: string
      input_tokens: number | null
      output_tokens: number | null
      cache_read_tokens: number | null
      cache_write_tokens: number | null
      cost_usd: number | null
      duration_ms: number | null
    }>(
      'SELECT id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms FROM vela_messages WHERE session_id = ? AND input_tokens IS NOT NULL',
      parentId,
    )
    for (const row of usageRows) {
      if (!branchIds.has(row.id)) continue
      messageUsage.set(row.id, {
        ...(row.input_tokens === null ? {} : { inputTokens: row.input_tokens }),
        ...(row.output_tokens === null
          ? {}
          : { outputTokens: row.output_tokens }),
        ...(row.cache_read_tokens === null
          ? {}
          : { cacheReadTokens: row.cache_read_tokens }),
        ...(row.cache_write_tokens === null
          ? {}
          : { cacheWriteTokens: row.cache_write_tokens }),
        ...(row.cost_usd === null ? {} : { costUsd: row.cost_usd }),
        ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
      })
    }
  }
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
  const targetIsLocal =
    params.targetLocation === undefined ||
    params.targetLocation.environment === 'local'
  let targetRemoteEnv: ExecutionEnv | undefined
  const sourceEnvCache = new Map<string, ExecutionEnv>()

  const getSourceEnv = async (
    location?: ExecutionLocation,
  ): Promise<ExecutionEnv | undefined> => {
    const effective = location ?? params.parentLocation
    const key = effective ? JSON.stringify(effective) : '__default__'
    const cached = sourceEnvCache.get(key)
    if (cached) return cached
    const env = await (params.resolveSourceEnv
      ? params.resolveSourceEnv(effective)
      : resolveEnv())
    sourceEnvCache.set(key, env)
    return env
  }

  const getTargetRemoteEnv = async (): Promise<ExecutionEnv | undefined> => {
    if (targetIsLocal) return undefined
    targetRemoteEnv ??= await resolveEnv()
    return targetRemoteEnv.id === 'node:local' ? undefined : targetRemoteEnv
  }

  const uniqueLocalDest = (sourcePath: string): string | undefined => {
    if (!targetSpillDir) return undefined
    mkdirSync(targetSpillDir, { recursive: true })
    const name = basename(sourcePath)
    let dest = join(targetSpillDir, name)
    if (existsSync(dest)) {
      dest = join(targetSpillDir, `${randomUUID().slice(0, 8)}-${name}`)
    }
    return dest
  }

  const resolveConfinedLocalSource = (
    sourcePath: string,
  ): { realSource: string; size: number } | undefined => {
    if (!realParentSpillDir || !existsSync(sourcePath)) return undefined
    let realSource: string
    try {
      realSource = realpathSync(sourcePath)
    } catch {
      return undefined
    }
    if (!realSource.startsWith(realParentSpillDir + sep)) return undefined
    let fd: number | undefined
    try {
      fd = openSync(realSource, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      const st = fstatSync(fd)
      if (!st.isFile()) return undefined
      return { realSource, size: st.size }
    } catch {
      return undefined
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  const readRemoteBytes = async (
    env: ExecutionEnv,
    sourcePath: string,
  ): Promise<Uint8Array | undefined> => {
    if (env.id === 'node:local') return undefined
    const opened = await env.openBinaryReader(sourcePath, { noFollow: true })
    if (!opened.ok) return undefined
    const reader = opened.value
    try {
      const info = await reader.info()
      if (!info.ok || info.value.kind !== 'file') return undefined
      if (info.value.size > MAX_REMOTE_SPILL_COPY_BYTES) return undefined
      const read = await reader.read(0, info.value.size)
      return read.ok ? read.value : undefined
    } finally {
      await reader.close()
    }
  }

  const writeRemoteSpill = async (
    destEnv: ExecutionEnv,
    sourcePath: string,
    bytes: Uint8Array,
  ): Promise<void> => {
    const temp = await destEnv.createTempFile({
      prefix: 'vela-result-',
      suffix: '.txt',
    })
    if (!temp.ok) return
    const written = await destEnv.writeFile(temp.value, bytes)
    if (!written.ok) {
      await destEnv.remove(temp.value, { force: true }).catch(() => {})
      return
    }
    spillRewrites.set(sourcePath, temp.value)
    rewrites.push([sourcePath, temp.value])
  }

  const copySpillFile = async (
    sourcePath: string | undefined,
    location?: ExecutionLocation,
  ) => {
    if (!sourcePath || spillRewrites.has(sourcePath)) return
    const effectiveLoc = location ?? params.parentLocation
    const srcIsLocal =
      effectiveLoc === undefined ||
      effectiveLoc.environment === 'local' ||
      effectiveLoc.environment === 'node:local'
    if (srcIsLocal && targetIsLocal) {
      if (!targetSpillDir || targetSpillDir === params.parentSpillDir) return
      const localSrc = resolveConfinedLocalSource(sourcePath)
      if (!localSrc) return
      const dest = uniqueLocalDest(sourcePath)
      if (!dest) return
      copyFileSync(localSrc.realSource, dest)
      spillRewrites.set(sourcePath, dest)
      rewrites.push([sourcePath, dest])
      return
    }

    let bytes: Uint8Array | undefined
    if (srcIsLocal) {
      const localSrc = resolveConfinedLocalSource(sourcePath)
      if (!localSrc || localSrc.size > MAX_REMOTE_SPILL_COPY_BYTES) return
      bytes = readFileSync(localSrc.realSource)
    } else {
      const srcEnv = await getSourceEnv(effectiveLoc)
      if (!srcEnv) return
      bytes = await readRemoteBytes(srcEnv, sourcePath)
    }
    if (!bytes) return

    if (targetIsLocal) {
      const dest = uniqueLocalDest(sourcePath)
      if (!dest) return
      writeFileSync(dest, bytes)
      spillRewrites.set(sourcePath, dest)
      rewrites.push([sourcePath, dest])
      return
    }
    const destEnv = await getTargetRemoteEnv()
    if (destEnv) await writeRemoteSpill(destEnv, sourcePath, bytes)
  }

  for (const row of parentCalls) {
    await copySpillFile(
      row.spill_path ?? undefined,
      parseRowLocation(row.location_json),
    )
  }
  for (const entry of branch) {
    if (entry.type === 'bash_execution') {
      await copySpillFile(
        entry.fullOutputPath,
        params.entryLocations?.get(entry.id),
      )
    }
  }

  const cloned = structuredClone(branch)
  if (rewrites.length) rewriteEntryStrings(cloned, rewrites)
  return {
    entries: copyBranch(cloned),
    parentCalls,
    messageUsage,
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
      rewrites.length
        ? rewriteJsonText(row.input_json, rewrites)
        : row.input_json,
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
        ? rewriteJsonText(row.result_json, rewrites)
        : row.result_json,
      rewrittenSpill,
      row.details_json !== null && rewrites.length
        ? rewriteJsonText(row.details_json, rewrites)
        : row.details_json,
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

function rewriteJsonValue(
  value: unknown,
  rewrites: readonly [string, string][],
): unknown {
  if (typeof value === 'string') return rewriteText(value, rewrites)
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const updated = rewriteJsonValue(item, rewrites)
      if (updated !== item) changed = true
      return updated
    })
    return changed ? next : value
  }
  if (value !== null && typeof value === 'object') {
    let changed = false
    const next: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      const updated = rewriteJsonValue(entry, rewrites)
      if (updated !== entry) changed = true
      next[key] = updated
    }
    return changed ? next : value
  }
  return value
}

function rewriteJsonText(
  raw: string,
  rewrites: readonly [string, string][],
): string {
  try {
    const parsed = JSON.parse(raw) as unknown
    const updated = rewriteJsonValue(parsed, rewrites)
    return updated === parsed ? raw : JSON.stringify(updated)
  } catch {
    return rewriteText(raw, rewrites)
  }
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
          } else if (part.type === 'tool_call') {
            part.input = rewriteJsonValue(part.input, rewrites)
          } else if (part.type === 'tool_result') {
            if (
              (part.output.type === 'text' ||
                part.output.type === 'error-text') &&
              typeof part.output.value === 'string'
            ) {
              part.output.value = rewriteText(part.output.value, rewrites)
            } else if (
              part.output.type === 'json' ||
              part.output.type === 'error-json'
            ) {
              part.output.value = rewriteJsonValue(
                part.output.value,
                rewrites,
              ) as typeof part.output.value
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
      if (entry.details) {
        entry.details = rewriteJsonValue(entry.details, rewrites) as Record<
          string,
          unknown
        >
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
