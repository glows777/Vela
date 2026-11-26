import type { VelaDatabase } from '../../db/index.ts'
import { canonicalLocalPath } from '../../db/trust.ts'
import type { ThinkingLevel } from '../../providers/models/index.ts'
import { validateStoredLocation } from '../execution/location.ts'
import type { ExecutionLocation } from '../execution/types.ts'
import type { ModelMessage } from '../messages.ts'
import {
  collectRowMetadata,
  computeLatestAssistantUsage,
  getSessionChannel,
  loadAllSessionRows,
  loadSessionMeta,
  type MessageRow,
  rowToEntry,
  type SessionRow,
} from './db-store.ts'
import {
  buildSessionContext,
  buildSessionPath,
  contextEntries,
  messageText,
  type SessionEntry,
  type SessionSummary,
} from './entries.ts'
import type { LoadedSessionContext } from './options.ts'
import { type SessionSearchHit, searchSessionText } from './search.ts'

export interface SessionListFilter {
  projectId?: string
  cwd?: string
  excludeChannels?: boolean
}

export function listSessionSummariesFromDb(
  db: VelaDatabase,
  includeArchived = false,
  filter?: SessionListFilter,
): SessionSummary[] {
  const sessions = filter?.projectId
    ? db.all<SessionRow>(
        `SELECT * FROM sessions
         WHERE project_id = ?${includeArchived ? '' : ' AND archived = 0'}
         ORDER BY updated_at DESC`,
        filter.projectId,
      )
    : db.all<SessionRow>(
        `SELECT * FROM sessions
         ${includeArchived ? '' : 'WHERE archived = 0'}
         ORDER BY updated_at DESC`,
      )
  const targetCwd = filter?.cwd ? canonicalLocalPath(filter.cwd) : undefined
  const matchingProjectIds = new Set<string>()
  if (targetCwd && !filter?.projectId) {
    const projects = db.all<{ id: string; cwd: string | null }>(
      'SELECT id, cwd FROM projects WHERE cwd IS NOT NULL',
    )
    for (const p of projects) {
      if (p.cwd && canonicalLocalPath(p.cwd) === targetCwd) {
        matchingProjectIds.add(p.id)
      }
    }
  }

  const summaries: SessionSummary[] = []
  for (const session of sessions) {
    const location = session.location_json
      ? (JSON.parse(session.location_json) as { cwd?: string })
      : undefined
    if (targetCwd && !filter?.projectId) {
      if (session.project_id !== null) {
        if (!matchingProjectIds.has(session.project_id)) continue
      } else if (
        location?.cwd === undefined ||
        canonicalLocalPath(location.cwd) !== targetCwd
      ) {
        continue
      }
    }
    const channel = getSessionChannel(db, session.id)
    if (filter?.excludeChannels && channel) continue
    const countRow = db.get<{ n: number }>(
      "SELECT count(*) AS n FROM vela_messages WHERE session_id = ? AND kind IN ('message', 'bash_execution')",
      session.id,
    )
    const messageCount = countRow?.n ?? 0
    if (messageCount === 0) continue

    const firstRow = db.get<MessageRow>(
      `SELECT * FROM vela_messages
       WHERE session_id = ?
         AND ((kind = 'message' AND role = 'user') OR kind = 'bash_execution')
       ORDER BY seq ASC
       LIMIT 1`,
      session.id,
    )
    let firstMessage = ''
    if (firstRow) {
      const entry = rowToEntry(firstRow)
      if (entry.type === 'bash_execution') {
        firstMessage =
          `${entry.excludeFromContext ? '!!' : '!'}${entry.command}`
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120)
      } else if (entry.type === 'message') {
        firstMessage = messageText(entry.message.content)
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120)
      }
    }

    summaries.push({
      id: session.id,
      ...(session.name ? { name: session.name } : {}),
      updatedAt: session.updated_at,
      messageCount,
      firstMessage,
      ...(location?.cwd ? { cwd: location.cwd } : {}),
      ...(channel ? { channel } : {}),
      ...(session.archived ? { archived: true } : {}),
    })
  }
  return summaries
}

export function setSavedSessionArchivedInDb(
  db: VelaDatabase,
  sessionId: string,
  archived: boolean,
): boolean {
  const existing = db.get<{ archived: number }>(
    'SELECT archived FROM sessions WHERE id = ?',
    sessionId,
  )
  const hasMessages = db.get<{ n: number }>(
    'SELECT count(*) AS n FROM vela_messages WHERE session_id = ?',
    sessionId,
  )?.n
  if (!existing || !hasMessages) {
    throw new Error(`Session ${sessionId} has nothing saved to archive`)
  }
  const flag = archived ? 1 : 0
  if (existing.archived === flag) return false
  db.run(
    'UPDATE sessions SET archived = ?, updated_at = ? WHERE id = ?',
    flag,
    new Date().toISOString(),
    sessionId,
  )
  return true
}

export function searchSessionsInDb(
  db: VelaDatabase,
  query: string,
  includeArchived: boolean,
  filter?: SessionListFilter,
): SessionSearchHit[] {
  const text = query.trim()
  if (!text) return []
  const hits: SessionSearchHit[] = []
  for (const summary of listSessionSummariesFromDb(
    db,
    includeArchived,
    filter,
  )) {
    const entries = loadAllSessionRows(db, summary.id).map(rowToEntry)
    const match = entries.length ? searchSessionText(entries, text) : undefined
    if (match) hits.push({ id: summary.id, match })
  }
  return hits
}

export interface HydratedSavedSession {
  entries: SessionEntry[]
  seq: number
  leaf: string | null
  location?: ExecutionLocation
  name?: string
  model?: string
  thinkingLevel?: ThinkingLevel
  archived: boolean
  parentSessionId?: string
  createdAt: string
  discoveredTools: string[]
  channel?: string
  entryModel: Map<string, string>
  entryThinking: Map<string, ThinkingLevel>
  entryLocations: Map<string, ExecutionLocation>
  context: LoadedSessionContext & {
    ids: Map<ModelMessage, string>
    producers: Map<ModelMessage, string>
  }
}

export function loadSavedSessionFromDb(
  db: VelaDatabase,
  sessionId: string,
): HydratedSavedSession | undefined {
  const meta = loadSessionMeta(db, sessionId)
  if (!meta.row) return undefined
  const rows = loadAllSessionRows(db, sessionId)
  const entries = rows.map(rowToEntry)
  const seq = rows.reduce((max, r) => Math.max(max, r.seq), 0)
  const location = meta.row.location_json
    ? (JSON.parse(meta.row.location_json) as ExecutionLocation)
    : undefined
  if (location !== undefined) validateStoredLocation(location)
  const leaf = meta.row.leaf_message_id
  const byId = new Map(entries.map((e) => [e.id, e]))
  const path = buildSessionPath(entries, leaf, byId)
  const context = buildSessionContext(entries, leaf, byId)
  const activeCompaction = contextEntries(path).compaction
  if (activeCompaction) {
    const compRow = rows.find((r) => r.id === activeCompaction.id)
    if (compRow?.details_json) {
      try {
        const parsedDetails = JSON.parse(compRow.details_json) as {
          preservedEntryIds?: unknown
        }
        if (Array.isArray(parsedDetails.preservedEntryIds)) {
          const presentIds = new Set(context.ids.values())
          let insertAt = 1
          for (const rawId of parsedDetails.preservedEntryIds) {
            if (typeof rawId !== 'string' || presentIds.has(rawId)) continue
            const retained = byId.get(rawId)
            if (retained?.type !== 'custom_message') continue
            const msg: ModelMessage = {
              role: 'user',
              content: retained.content,
            }
            context.messages.splice(insertAt++, 0, msg)
            context.ids.set(msg, retained.id)
            const parsedTime = Date.parse(retained.timestamp)
            context.timestamps.set(
              msg,
              Number.isFinite(parsedTime) ? parsedTime : Date.now(),
            )
            context.custom.set(msg, {
              customType: retained.customType,
              display: retained.display,
              ...(retained.details === undefined
                ? {}
                : { details: retained.details }),
            })
            presentIds.add(retained.id)
          }
        }
      } catch {
        /* ignore malformed compaction details */
      }
    }
  }
  const activeIds = new Set(path.map((e) => e.id))
  const latestAssistantUsage = computeLatestAssistantUsage(
    rows,
    activeIds,
    context.messages,
    context.ids,
  )
  const entryModel = new Map<string, string>()
  const entryThinking = new Map<string, ThinkingLevel>()
  const entryLocations = new Map<string, ExecutionLocation>()
  collectRowMetadata(rows, entryModel, entryThinking, entryLocations)
  const channel = meta.channel ?? getSessionChannel(db, sessionId)
  return {
    entries,
    seq,
    leaf,
    location,
    name: meta.row.name ?? undefined,
    model: meta.model,
    thinkingLevel: meta.thinkingLevel,
    archived: meta.row.archived === 1,
    parentSessionId: meta.row.parent_session_id ?? undefined,
    createdAt: meta.row.created_at,
    discoveredTools: meta.discoveredTools,
    channel,
    entryModel,
    entryThinking,
    entryLocations,
    context: {
      ...context,
      channel,
      location,
      name: meta.row.name ?? undefined,
      model: meta.model,
      thinkingLevel: meta.thinkingLevel,
      discoveredTools: [...meta.discoveredTools],
      latestAssistantUsage,
    },
  }
}
