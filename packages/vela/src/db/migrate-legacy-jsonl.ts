import { randomUUID } from 'node:crypto'
import { normalizeVelaMessage, type VelaMessage } from '../shared/messages.ts'

type MigratedMessageKind =
  | 'message'
  | 'compaction'
  | 'branch_summary'
  | 'bash_execution'
  | 'custom_message'
  | 'custom'

interface ParsedLegacyMessageRow {
  id: string
  parentId: string | null
  seq: number
  kind: MigratedMessageKind
  role: string | null
  contentJson: string
  includeInContext: boolean
  stopReason: string | null
  producedBy: string | null
  firstKeptId: string | null
  tokensBefore: number | null
  label: string | null
  detailsJson: string | null
  createdAt: string
}

export interface ParsedLegacyTranscript {
  sessionId: string
  createdAt: string
  updatedAt: string
  cwd?: string
  location?: unknown
  channel?: string
  parentSession?: string
  name?: string
  archived?: boolean
  model?: string
  thinkingLevel?: string
  discoveredTools?: string[]
  leafMessageId: string | null
  messages: ParsedLegacyMessageRow[]
  warnings: string[]
}

interface RawEntry {
  type: string
  id: string
  parentId: string | null
  timestamp: string
  [key: string]: unknown
}

const KEPT_ENTRY_TYPES = new Set<MigratedMessageKind>([
  'message',
  'compaction',
  'branch_summary',
  'bash_execution',
  'custom_message',
  'custom',
])

const LOCATION_MARKER_TYPE = 'vela.session.location'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidExecutionLocation(
  value: unknown,
): value is { environment: string; cwd: string } {
  return (
    isPlainObject(value) &&
    typeof value.environment === 'string' &&
    value.environment.length > 0 &&
    typeof value.cwd === 'string' &&
    value.cwd.length > 0
  )
}

function extractLoadedToolNames(text: string): string[] {
  const names: string[] = []
  for (const line of text.split('\n')) {
    const end = line.indexOf(': ')
    if (!line.startsWith('- ') || end < 0) {
      if (names.length) break
      continue
    }
    names.push(line.slice(2, end))
  }
  return names
}

function extractDiscoveredToolsFromMessage(message: VelaMessage): string[] {
  if (message.role !== 'tool' || !Array.isArray(message.content)) return []
  const names: string[] = []
  for (const part of message.content) {
    if (
      !isPlainObject(part) ||
      part.type !== 'tool_result' ||
      part.toolName !== 'tool_search' ||
      !isPlainObject(part.output)
    ) {
      continue
    }
    if (part.output.type === 'text' && typeof part.output.value === 'string') {
      names.push(...extractLoadedToolNames(part.output.value))
    } else if (
      part.output.type === 'json' &&
      isPlainObject(part.output.value) &&
      typeof part.output.value.preview === 'string'
    ) {
      names.push(...extractLoadedToolNames(part.output.value.preview))
    }
  }
  return names
}

function createSyntheticId(taken: Set<string>): string {
  for (let i = 0; i < 100; i++) {
    const candidate = randomUUID().slice(0, 8)
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
  const fallback = randomUUID()
  taken.add(fallback)
  return fallback
}

function isV1Transcript(lines: unknown[]): boolean {
  const first = lines[0] as { type?: unknown; id?: unknown } | undefined
  return (
    first?.type === 'checkpoint' ||
    (first?.type === 'message' && first.id === undefined)
  )
}

function convertV1ToEntries(
  sessionId: string,
  lines: unknown[],
): { header: Record<string, unknown>; entries: RawEntry[] } {
  let checkpoint: {
    timestamp?: string
    messages: { timestamp?: string; message: VelaMessage }[]
    model?: string
    thinkingLevel?: string
    name?: string
    summary?: string
  } = { messages: [] }

  for (const rawLine of lines) {
    if (!isPlainObject(rawLine)) continue
    if (rawLine.type === 'checkpoint' && Array.isArray(rawLine.messages)) {
      checkpoint = {
        timestamp:
          typeof rawLine.timestamp === 'string' ? rawLine.timestamp : undefined,
        messages: [
          ...(rawLine.messages as {
            timestamp?: string
            message: VelaMessage
          }[]),
        ],
        model: typeof rawLine.model === 'string' ? rawLine.model : undefined,
        thinkingLevel:
          typeof rawLine.thinkingLevel === 'string'
            ? rawLine.thinkingLevel
            : undefined,
        name: typeof rawLine.name === 'string' ? rawLine.name : undefined,
        summary:
          typeof rawLine.summary === 'string' ? rawLine.summary : undefined,
      }
    } else if (rawLine.type === 'message' && isPlainObject(rawLine.message)) {
      checkpoint.messages.push({
        timestamp:
          typeof rawLine.timestamp === 'string'
            ? rawLine.timestamp
            : new Date().toISOString(),
        message: rawLine.message as unknown as VelaMessage,
      })
    }
  }

  const fallbackTime =
    checkpoint.timestamp ??
    checkpoint.messages[0]?.timestamp ??
    new Date().toISOString()
  const header: Record<string, unknown> = {
    type: 'session',
    version: 2,
    id: sessionId,
    timestamp: checkpoint.messages[0]?.timestamp ?? fallbackTime,
  }

  const entries: RawEntry[] = []
  const taken = new Set<string>()
  const push = (entry: {
    type: string
    timestamp: string
    [key: string]: unknown
  }) => {
    const id = createSyntheticId(taken)
    entries.push({
      ...entry,
      id,
      parentId: entries.at(-1)?.id ?? null,
    })
  }

  const firstTime = checkpoint.messages[0]?.timestamp ?? fallbackTime
  if (checkpoint.model) {
    push({
      type: 'model_change',
      timestamp: firstTime,
      model: checkpoint.model,
    })
  }
  if (checkpoint.thinkingLevel) {
    push({
      type: 'thinking_level_change',
      timestamp: firstTime,
      thinkingLevel: checkpoint.thinkingLevel,
    })
  }

  const summary = checkpoint.summary
  const expectedSummaryText = summary
    ? `[Summary of the earlier conversation]\n${summary}`
    : undefined
  const firstContent = checkpoint.messages[0]?.message?.content
  const compacted = Boolean(summary && firstContent === expectedSummaryText)

  for (const item of checkpoint.messages.slice(compacted ? 1 : 0)) {
    push({
      type: 'message',
      timestamp: item.timestamp ?? fallbackTime,
      message: item.message,
    })
  }

  if (compacted && summary) {
    const firstKept = entries.find((entry) => entry.type === 'message')
    push({
      type: 'compaction',
      timestamp: checkpoint.messages[0]?.timestamp ?? fallbackTime,
      summary,
      firstKeptEntryId: firstKept?.id ?? '',
      tokensBefore: 0,
    })
    const compaction = entries.at(-1)!
    if (!compaction.firstKeptEntryId) {
      compaction.firstKeptEntryId = compaction.id
    }
  }

  if (checkpoint.name) {
    push({
      type: 'session_info',
      timestamp: fallbackTime,
      name: checkpoint.name,
    })
  }

  return { header, entries }
}

/**
 * Pure read-only parser for legacy JSONL session transcripts (supports V2 tree logs,
 * V1 checkpoints, and 0.5.0 flat files while skipping damaged lines with redacted warnings).
 * Folds `vela.session.location`, scopes `context_edit` to the active branch, validates
 * `compaction.firstKeptEntryId` against the compaction branch, and re-chains `parentId`.
 */
export function parseLegacyTranscript(
  text: string,
  sessionId: string,
  filePath: string,
): ParsedLegacyTranscript {
  const warnings: string[] = []
  const parsedLines: { lineNum: number; value: unknown }[] = []
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim()
    if (!raw) continue
    try {
      parsedLines.push({ lineNum: i + 1, value: JSON.parse(raw) })
    } catch {
      warnings.push(`Skipped unparsable line ${i + 1} in ${filePath}`)
    }
  }

  let header: Record<string, unknown> | undefined
  const entries: RawEntry[] = []

  if (
    parsedLines.length > 0 &&
    isV1Transcript(parsedLines.map((item) => item.value))
  ) {
    const converted = convertV1ToEntries(
      sessionId,
      parsedLines.map((item) => item.value),
    )
    header = converted.header
    entries.push(...converted.entries)
  } else {
    const seenIds = new Set<string>()
    for (const { lineNum, value: item } of parsedLines) {
      if (!isPlainObject(item) || typeof item.type !== 'string') {
        warnings.push(`Skipped invalid entry at line ${lineNum} in ${filePath}`)
        continue
      }
      if (item.type === 'session' && !header) {
        if (
          item.version !== undefined &&
          (typeof item.version !== 'number' || item.version > 2)
        ) {
          throw new Error(
            `Unsupported transcript version ${String(item.version)} in ${filePath}`,
          )
        }
        header = item
        continue
      }
      if (typeof item.id !== 'string') {
        warnings.push(
          `Skipped entry without id at line ${lineNum} in ${filePath}`,
        )
        continue
      }
      if (seenIds.has(item.id)) {
        warnings.push(`Skipped duplicate entry id "${item.id}" in ${filePath}`)
        continue
      }
      if (
        item.type === 'message' &&
        (!isPlainObject(item.message) || typeof item.message.role !== 'string')
      ) {
        warnings.push(
          `Skipped malformed message entry at line ${lineNum} in ${filePath}`,
        )
        continue
      }
      seenIds.add(item.id)
      entries.push({
        ...item,
        type: item.type,
        id: item.id,
        parentId: typeof item.parentId === 'string' ? item.parentId : null,
        timestamp:
          typeof item.timestamp === 'string'
            ? item.timestamp
            : new Date().toISOString(),
      })
    }
  }

  const rawById = new Map(entries.map((entry) => [entry.id, entry]))
  const isKeptEntry = (entry: RawEntry): boolean => {
    if (!KEPT_ENTRY_TYPES.has(entry.type as MigratedMessageKind)) return false
    if (entry.type === 'custom' && entry.customType === LOCATION_MARKER_TYPE) {
      return false
    }
    return true
  }
  const keptIds = new Set(entries.filter(isKeptEntry).map((entry) => entry.id))

  const resolveKeptAncestor = (
    startId: string | null,
    selfId?: string,
  ): string | null => {
    let cur = startId
    const visited = new Set<string>()
    if (selfId) visited.add(selfId)
    while (cur) {
      if (visited.has(cur)) {
        warnings.push(
          `Broke cyclic parent reference near entry "${cur}" in ${filePath}`,
        )
        return null
      }
      if (keptIds.has(cur)) return cur
      visited.add(cur)
      cur = rawById.get(cur)?.parentId ?? null
    }
    return null
  }

  const branchEntries = (leafId: string | null): RawEntry[] => {
    const path: RawEntry[] = []
    const visited = new Set<string>()
    let cur = leafId
    while (cur && !visited.has(cur)) {
      const node = rawById.get(cur)
      if (!node) break
      visited.add(cur)
      path.push(node)
      cur = node.parentId
    }
    return path.reverse()
  }

  const activeBranch = branchEntries(entries.at(-1)?.id ?? null)

  let name: string | undefined
  let archived: boolean | undefined
  let channel = typeof header?.channel === 'string' ? header.channel : undefined
  let location: unknown = isValidExecutionLocation(header?.location)
    ? header.location
    : header?.location
  let model: string | undefined
  let thinkingLevel: string | undefined

  const labels = new Map<string, string | undefined>()
  const activeEdits = new Map<string, { content: unknown } | null>()

  for (const entry of entries) {
    if (entry.type === 'session_info') {
      name =
        typeof entry.name === 'string' && entry.name.trim()
          ? entry.name.trim()
          : undefined
    } else if (
      entry.type === 'session_archived' &&
      typeof entry.archived === 'boolean'
    ) {
      archived = entry.archived
    } else if (
      entry.type === 'session_channel' &&
      typeof entry.channel === 'string'
    ) {
      channel = entry.channel
    } else if (entry.type === 'label' && typeof entry.targetId === 'string') {
      labels.set(
        entry.targetId,
        typeof entry.label === 'string' && entry.label
          ? entry.label
          : undefined,
      )
    } else if (
      entry.type === 'custom' &&
      entry.customType === LOCATION_MARKER_TYPE &&
      isValidExecutionLocation(entry.data)
    ) {
      location = entry.data
    }
  }

  for (const entry of activeBranch) {
    if (entry.type === 'model_change' && typeof entry.model === 'string') {
      model = entry.model
    } else if (
      entry.type === 'thinking_level_change' &&
      typeof entry.thinkingLevel === 'string'
    ) {
      thinkingLevel = entry.thinkingLevel
    } else if (
      entry.type === 'context_edit' &&
      typeof entry.targetId === 'string'
    ) {
      if (entry.replacement === null) {
        activeEdits.set(entry.targetId, null)
      } else if (isPlainObject(entry.replacement)) {
        activeEdits.set(entry.targetId, { content: entry.replacement.content })
      }
    }
  }

  const resolveFirstKeptId = (compaction: RawEntry): string => {
    const rawFirstKept =
      typeof compaction.firstKeptEntryId === 'string'
        ? compaction.firstKeptEntryId
        : ''
    const path = branchEntries(compaction.id)
    const startIdx = rawFirstKept
      ? path.findIndex((item) => item.id === rawFirstKept)
      : -1
    if (startIdx >= 0) {
      for (let i = startIdx; i < path.length; i++) {
        if (keptIds.has(path[i]!.id)) return path[i]!.id
      }
      return compaction.id
    }
    if (rawFirstKept) {
      warnings.push(
        `Clamped out-of-branch compaction boundary "${rawFirstKept}" to "${compaction.id}" in ${filePath}`,
      )
    }
    return compaction.id
  }

  const messages: ParsedLegacyMessageRow[] = []
  const discoveredTools: string[] = []
  const seenTools = new Set<string>()
  const activeBranchIds = new Set(activeBranch.map((entry) => entry.id))
  const resolvedParentByKeptId = new Map<string, string | null>()
  let seq = 0

  const resolveAcyclicParentId = (
    rawParentId: string | null,
    selfId: string,
  ): string | null => {
    const candidate = resolveKeptAncestor(rawParentId, selfId)
    if (!candidate) {
      resolvedParentByKeptId.set(selfId, null)
      return null
    }
    const seen = new Set<string>([selfId])
    let cur: string | null = candidate
    while (cur) {
      if (seen.has(cur)) {
        warnings.push(
          `Broke cyclic parent reference near entry "${selfId}" in ${filePath}`,
        )
        resolvedParentByKeptId.set(selfId, null)
        return null
      }
      seen.add(cur)
      cur = resolvedParentByKeptId.get(cur) ?? null
    }
    resolvedParentByKeptId.set(selfId, candidate)
    return candidate
  }

  for (const entry of entries) {
    if (!keptIds.has(entry.id)) continue
    const kind = entry.type as MigratedMessageKind
    seq += 1
    const parentId = resolveAcyclicParentId(entry.parentId, entry.id)
    const label = labels.get(entry.id) ?? null
    const edit = activeEdits.get(entry.id)

    if (kind === 'message') {
      const normalized = normalizeVelaMessage(entry.message)
      if (activeBranchIds.has(entry.id)) {
        for (const toolName of extractDiscoveredToolsFromMessage(normalized)) {
          if (!seenTools.has(toolName)) {
            seenTools.add(toolName)
            discoveredTools.push(toolName)
          }
        }
      }
      const editedMessage =
        edit && edit !== null
          ? normalizeVelaMessage({ ...normalized, content: edit.content })
          : normalized
      const stopReason =
        typeof entry.stopReason === 'string' ? entry.stopReason : null
      const producedBy =
        typeof entry.producedBy === 'string' ? entry.producedBy : null
      const detailsPayload: Record<string, unknown> = {}
      if (entry.details !== undefined) detailsPayload.details = entry.details
      if (entry.nestedCalls !== undefined)
        detailsPayload.nestedCalls = entry.nestedCalls
      messages.push({
        id: entry.id,
        parentId,
        seq,
        kind,
        role:
          typeof (editedMessage as { role?: unknown }).role === 'string'
            ? (editedMessage as { role: string }).role
            : null,
        contentJson: JSON.stringify(editedMessage),
        includeInContext: stopReason === null && edit !== null,
        stopReason,
        producedBy,
        firstKeptId: null,
        tokensBefore: null,
        label,
        detailsJson:
          Object.keys(detailsPayload).length > 0
            ? JSON.stringify(detailsPayload)
            : null,
        createdAt: entry.timestamp,
      })
      continue
    }

    if (kind === 'compaction') {
      messages.push({
        id: entry.id,
        parentId,
        seq,
        kind,
        role: 'user',
        contentJson: JSON.stringify({
          summary: typeof entry.summary === 'string' ? entry.summary : '',
        }),
        includeInContext: true,
        stopReason: null,
        producedBy: null,
        firstKeptId: resolveFirstKeptId(entry),
        tokensBefore:
          typeof entry.tokensBefore === 'number' ? entry.tokensBefore : null,
        label,
        detailsJson: null,
        createdAt: entry.timestamp,
      })
      continue
    }

    if (kind === 'branch_summary') {
      messages.push({
        id: entry.id,
        parentId,
        seq,
        kind,
        role: 'user',
        contentJson: JSON.stringify({
          fromId: typeof entry.fromId === 'string' ? entry.fromId : 'root',
          summary: typeof entry.summary === 'string' ? entry.summary : '',
        }),
        includeInContext: true,
        stopReason: null,
        producedBy: null,
        firstKeptId: null,
        tokensBefore: null,
        label,
        detailsJson: null,
        createdAt: entry.timestamp,
      })
      continue
    }

    if (kind === 'bash_execution') {
      const excluded = entry.excludeFromContext === true
      messages.push({
        id: entry.id,
        parentId,
        seq,
        kind,
        role: 'user',
        contentJson: JSON.stringify({
          command: entry.command,
          output: entry.output,
          ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
          cancelled: entry.cancelled === true,
          truncated: entry.truncated === true,
          ...(entry.fullOutputPath !== undefined
            ? { fullOutputPath: entry.fullOutputPath }
            : {}),
          ...(excluded ? { excludeFromContext: true } : {}),
          ...(entry.backgroundTaskId !== undefined
            ? { backgroundTaskId: entry.backgroundTaskId }
            : {}),
        }),
        includeInContext: !excluded && edit !== null,
        stopReason: null,
        producedBy: null,
        firstKeptId: null,
        tokensBefore: null,
        label,
        detailsJson: null,
        createdAt: entry.timestamp,
      })
      continue
    }

    if (kind === 'custom_message') {
      const content = edit && edit !== null ? edit.content : entry.content
      messages.push({
        id: entry.id,
        parentId,
        seq,
        kind,
        role: 'user',
        contentJson: JSON.stringify({
          customType: entry.customType,
          content,
          display: entry.display === true,
        }),
        includeInContext: edit !== null,
        stopReason: null,
        producedBy: null,
        firstKeptId: null,
        tokensBefore: null,
        label,
        detailsJson:
          entry.details !== undefined ? JSON.stringify(entry.details) : null,
        createdAt: entry.timestamp,
      })
      continue
    }

    messages.push({
      id: entry.id,
      parentId,
      seq,
      kind,
      role: null,
      contentJson: JSON.stringify({
        customType: entry.customType,
        ...(entry.data !== undefined ? { data: entry.data } : {}),
      }),
      includeInContext: false,
      stopReason: null,
      producedBy: null,
      firstKeptId: null,
      tokensBefore: null,
      label,
      detailsJson: null,
      createdAt: entry.timestamp,
    })
  }

  let createdAt =
    typeof header?.timestamp === 'string'
      ? header.timestamp
      : (entries[0]?.timestamp ?? new Date().toISOString())
  let updatedAt = createdAt
  for (const entry of entries) {
    if (entry.timestamp > updatedAt) updatedAt = entry.timestamp
    if (entry.timestamp < createdAt) createdAt = entry.timestamp
  }

  return {
    sessionId,
    createdAt,
    updatedAt,
    ...(typeof header?.cwd === 'string' ? { cwd: header.cwd } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(channel !== undefined ? { channel } : {}),
    ...(typeof header?.parentSession === 'string'
      ? { parentSession: header.parentSession }
      : {}),
    ...(name !== undefined ? { name } : {}),
    ...(archived !== undefined ? { archived } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    ...(discoveredTools.length > 0 ? { discoveredTools } : {}),
    leafMessageId: entries.length
      ? resolveKeptAncestor(entries.at(-1)!.id)
      : null,
    messages,
    warnings,
  }
}
