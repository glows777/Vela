import { basename, resolve } from 'node:path'
import type z from 'zod'
import type { VelaDatabase } from '../../db/index.ts'
import { generateProviderText } from '../../providers/index.ts'
import {
  bm25Search,
  type MemoryEntry,
  type MemoryStore,
} from '../../runtime/memory/index.ts'
import type { VelaLogger } from '../../shared/logger.ts'
import type { ModelPricing } from '../../shared/pricing.ts'
import type { ModelInput, ProviderUsage } from '../../shared/provider-types.ts'
import type { ModelMessage } from '../messages.ts'
import { normalizeUsage, type StepUsage } from '../usage/tracker.ts'
import type { VelaSession } from '../vela-session.ts'
import {
  DEFAULT_DREAM_KV_STATE,
  DREAM_INSTRUCTIONS,
  DREAM_REPAIR,
  type DreamKvState,
  type DreamLogEntry,
  type DreamPendingRef,
  type DreamRunRecord,
  type DreamScope,
  type DreamTurn,
  dreamAssistantToolNames,
  dreamKvKey,
  dreamMessageText,
  dreamNoteInput,
  dreamResponseSchema,
  dreamTurnByteSize,
  formatDreamReplyError,
  mutateDreamKvState,
  parseDreamResponseJson,
  readDreamKvState,
} from './dream-state.ts'

export type {
  DreamKvState,
  DreamLogEntry,
  DreamPendingRef,
  DreamRunRecord,
  DreamScope,
  DreamTurn,
}
export { dreamKvKey, readDreamKvState }

const MAX_INBOX_BYTES = 100 * 1024
const NOTE_BUDGET = 60_000
const MAX_LOGS = 20
const DAY = 24 * 3600_000
const HYDRATE_PAGE_SIZE = 50
const MAX_TRACKED_SESSIONS = 200
const MAX_IDS_PER_SESSION = 100

export interface DreamRunnerContext {
  sessionId: string
  model: ModelInput
  pricing?: ModelPricing
  recordUsage: (
    modelId: string,
    usage: StepUsage,
    meta: { kind: 'dream'; usage: ProviderUsage; durationMs: number },
    pricing: { value: ModelPricing | undefined },
  ) => void
}

function sessionRunnerContext(session: VelaSession): DreamRunnerContext {
  return {
    sessionId: session.id,
    model: session.model,
    pricing: session.modelInfo.cost,
    recordUsage: (modelId, usage, meta, pricing) => {
      session.tracker.record(modelId, usage, meta, pricing)
    },
  }
}

type StoredMessageRow = {
  row_id: number
  id: string
  session_id: string
  run_id: string | null
  content_json: string
  details_json: string | null
  created_at: string
}

/**
 * Store-local memory consolidation backed by `vela.db` (`kv_meta` monotonic sequence refs + `vela_messages`).
 * Never creates `.dream/` files on disk and never imports turns from other scopes or disabled turns.
 */
export class MemoryDream {
  readonly kvKey: string
  private running?: Promise<string>
  private controller?: AbortController
  private memoryState: DreamKvState = {
    ...DEFAULT_DREAM_KV_STATE,
    pendingRefs: [],
    logs: [],
  }

  constructor(
    private readonly store: MemoryStore,
    private readonly db?: VelaDatabase,
    readonly scope: DreamScope = {
      kind: 'tagged',
      key: `dir:${resolve(store.memoryDir)}`,
    },
  ) {
    this.kvKey = dreamKvKey(scope)
  }

  private state(): DreamKvState {
    if (!this.db?.open) return this.memoryState
    return readDreamKvState(this.db, this.kvKey, this.store.memoryDir)
  }

  private mutate(mutator: (state: DreamKvState) => DreamKvState): DreamKvState {
    const next = mutateDreamKvState(
      this.db,
      this.memoryState,
      this.kvKey,
      this.store.memoryDir,
      mutator,
    )
    if (!this.db?.open) this.memoryState = next
    return next
  }

  /** Records human-authored message IDs produced while `memory` was enabled in this scope. */
  recordMessages(
    sessionId: string,
    refs: ReadonlyArray<{ messageId: string; time: number }>,
  ): void {
    if (refs.length === 0) return
    this.mutate((state) => {
      const recent = { ...(state.recentMessageIds ?? {}) }
      const seenForSession = new Set([
        ...(recent[sessionId] ?? []),
        ...state.pendingRefs
          .filter((item) => item.sessionId === sessionId)
          .map((item) => item.messageId),
      ])
      const added: DreamPendingRef[] = []
      const recordedIds = [...(recent[sessionId] ?? [])]
      let nextSeq = state.nextSeq
      for (const ref of refs) {
        if (!ref.messageId || seenForSession.has(ref.messageId)) continue
        seenForSession.add(ref.messageId)
        recordedIds.push(ref.messageId)
        added.push({
          seq: nextSeq++,
          sessionId,
          messageId: ref.messageId,
          time: ref.time,
        })
      }
      if (added.length === 0) return state
      recent[sessionId] = recordedIds.slice(-MAX_IDS_PER_SESSION)
      const sessionKeys = Object.keys(recent)
      if (sessionKeys.length > MAX_TRACKED_SESSIONS) {
        for (const stale of sessionKeys.slice(
          0,
          sessionKeys.length - MAX_TRACKED_SESSIONS,
        )) {
          delete recent[stale]
        }
      }
      return {
        ...state,
        nextSeq,
        pendingRefs: [...state.pendingRefs, ...added],
        recentMessageIds: recent,
      }
    })
  }

  /** Collects human-authored user turns from the completed SDK session turn. */
  collect(session: VelaSession, turnMessages?: readonly ModelMessage[]): void {
    if (this.scope.kind !== 'tagged') return
    const sourceMsgs = turnMessages ?? session.messages
    const refs = sourceMsgs.flatMap((msg) => {
      if (msg.role !== 'user' || session.customMessageOf(msg)) return []
      const id = session.store.idOf(msg)
      return id ? [{ messageId: id, time: Date.now() }] : []
    })
    if (refs.length > 0) {
      this.recordMessages(session.id, refs)
    }
  }

  private pendingMetadata(
    state: DreamKvState,
  ): Array<{ seq: number; time: number }> {
    const legacy = (state.legacyTurns ?? [])
      .filter((t) => t.seq > state.cursorSeq)
      .map((t) => ({ seq: t.seq, time: t.time }))
    const live = state.pendingRefs
      .filter((r) => r.seq > state.cursorSeq)
      .map((r) => ({ seq: r.seq, time: r.time }))
    return [...legacy, ...live]
  }

  private hydrateRefBatch(
    batch: readonly DreamPendingRef[],
  ): Map<string, DreamTurn> {
    const result = new Map<string, DreamTurn>()
    if (!this.db?.open || batch.length === 0) return result
    const bySession = new Map<string, DreamPendingRef[]>()
    for (const ref of batch) {
      const list = bySession.get(ref.sessionId) ?? []
      list.push(ref)
      bySession.set(ref.sessionId, list)
    }
    for (const [sessionId, refs] of bySession) {
      const ids = refs.map((r) => r.messageId)
      const placeholders = ids.map(() => '?').join(', ')
      const rows = this.db.all<StoredMessageRow>(
        `SELECT rowid AS row_id, id, session_id, run_id, content_json, details_json, created_at
         FROM vela_messages
         WHERE session_id = ? AND id IN (${placeholders}) AND kind = 'message' AND role = 'user'`,
        sessionId,
        ...ids,
      )
      const rowById = new Map(rows.map((r) => [r.id, r]))
      for (const ref of refs) {
        const row = rowById.get(ref.messageId)
        if (!row) continue
        let userText = ''
        if (row.details_json) {
          try {
            const details = JSON.parse(row.details_json) as {
              dreamHumanText?: unknown
            }
            if (typeof details.dreamHumanText === 'string') {
              userText = details.dreamHumanText.slice(0, 2000)
            }
          } catch {
            /* ignore malformed details_json */
          }
        }
        if (!userText) {
          try {
            const parsed = JSON.parse(row.content_json) as ModelMessage
            userText = dreamMessageText(parsed).slice(0, 2000)
          } catch {
            continue
          }
        }
        if (!userText) continue
        const tools = this.collectTurnTools(sessionId, row)
        result.set(`${ref.sessionId}:${ref.messageId}:${ref.seq}`, {
          id: `${ref.sessionId}:${row.id}`,
          seq: ref.seq,
          sessionId: ref.sessionId,
          time: ref.time || Date.parse(row.created_at) || Date.now(),
          user: userText,
          tools,
        })
      }
    }
    return result
  }

  private collectTurnTools(sessionId: string, row: StoredMessageRow): string[] {
    if (!this.db?.open) return []
    let assistantRows: Array<{ content_json: string }>
    if (row.run_id) {
      assistantRows = this.db.all<{ content_json: string }>(
        `SELECT content_json FROM vela_messages
         WHERE session_id = ? AND run_id = ? AND kind = 'message' AND role = 'assistant'
         ORDER BY rowid ASC`,
        sessionId,
        row.run_id,
      )
    } else {
      const nextUser = this.db.get<{ next_rowid: number | null }>(
        `SELECT MIN(rowid) AS next_rowid FROM vela_messages
         WHERE session_id = ? AND kind = 'message' AND role = 'user' AND rowid > ?`,
        sessionId,
        row.row_id,
      )
      const upperBound = nextUser?.next_rowid ?? Number.MAX_SAFE_INTEGER
      assistantRows = this.db.all<{ content_json: string }>(
        `SELECT content_json FROM vela_messages
         WHERE session_id = ? AND kind = 'message' AND role = 'assistant' AND rowid > ? AND rowid < ?
         ORDER BY rowid ASC`,
        sessionId,
        row.row_id,
        upperBound,
      )
    }
    const tools: string[] = []
    const seen = new Set<string>()
    for (const aRow of assistantRows) {
      let parsed: ModelMessage | undefined
      try {
        parsed = JSON.parse(aRow.content_json) as ModelMessage
      } catch {
        continue
      }
      for (const name of dreamAssistantToolNames(parsed)) {
        if (!seen.has(name) && tools.length < 50) {
          seen.add(name)
          tools.push(name)
        }
      }
    }
    return tools
  }

  private pendingTurns(state = this.state()): {
    turns: DreamTurn[]
    dropped: number
    maxSeq: number
  } {
    type Candidate =
      | { kind: 'legacy'; seq: number; turn: DreamTurn }
      | { kind: 'ref'; seq: number; ref: DreamPendingRef }
    const candidates: Candidate[] = [
      ...(state.legacyTurns ?? [])
        .filter((t) => t.seq > state.cursorSeq)
        .map((turn): Candidate => ({ kind: 'legacy', seq: turn.seq, turn })),
      ...state.pendingRefs
        .filter((r) => r.seq > state.cursorSeq)
        .map((ref): Candidate => ({ kind: 'ref', seq: ref.seq, ref })),
    ].sort((a, b) => a.seq - b.seq)

    const maxSeq = candidates.at(-1)?.seq ?? state.cursorSeq
    if (candidates.length === 0) {
      return { turns: [], dropped: 0, maxSeq }
    }

    const kept: DreamTurn[] = []
    let bytes = 0
    let dropped = 0
    let budgetFull = false

    for (
      let end = candidates.length;
      end > 0 && !budgetFull;
      end -= HYDRATE_PAGE_SIZE
    ) {
      const start = Math.max(0, end - HYDRATE_PAGE_SIZE)
      const page = candidates.slice(start, end)
      const refBatch = page
        .filter((c): c is Candidate & { kind: 'ref' } => c.kind === 'ref')
        .map((c) => c.ref)
      const hydrated = this.hydrateRefBatch(refBatch)

      for (let i = page.length - 1; i >= 0; i--) {
        const candidate = page[i]!
        const turn =
          candidate.kind === 'legacy'
            ? candidate.turn
            : hydrated.get(
                `${candidate.ref.sessionId}:${candidate.ref.messageId}:${candidate.ref.seq}`,
              )
        if (!turn) continue
        const entrySize = dreamTurnByteSize(turn)
        if (bytes + entrySize > MAX_INBOX_BYTES && kept.length > 0) {
          dropped = start + i + 1
          budgetFull = true
          break
        }
        if (bytes + entrySize > MAX_INBOX_BYTES) {
          kept.push({ ...turn, user: turn.user.slice(0, 1000) })
          dropped = start + i
          budgetFull = true
          break
        }
        bytes += entrySize
        kept.push(turn)
      }
    }

    kept.reverse()
    return { turns: kept, dropped, maxSeq }
  }

  due(): boolean {
    if (this.running) return false
    const state = this.state()
    const meta = this.pendingMetadata(state)
    if (meta.length === 0) return false
    const last = state.lastRun
    if (last && (last.failed !== undefined || last.skipped !== undefined)) {
      const newerCount = meta.filter((m) => m.seq > last.attemptMaxSeq).length
      return newerCount >= 20 || Date.now() - last.time > DAY
    }
    return meta.length >= 20 || meta.some((m) => Date.now() - m.time > DAY)
  }

  status(): string {
    const state = this.state()
    const pending = this.pendingTurns(state)
    const last = state.lastRun
    const outcome =
      last?.failed !== undefined
        ? `failed: ${last.failed}`
        : last?.skipped !== undefined
          ? `skipped: ${last.skipped}`
          : `${last?.changes} changes`
    return `[dream] ${last ? `Last dream ${new Date(last.time).toISOString()}, ${outcome}` : 'No dream yet'}; inbox ${pending.turns.length} turns; ${pending.dropped} dropped${this.running ? '; running' : ''}`
  }

  auditState(): {
    cursorSeq: number
    lastRun?: DreamRunRecord
    logs: DreamLogEntry[]
    pendingTurns: DreamTurn[]
    dropped: number
  } {
    const state = this.state()
    const pending = this.pendingTurns(state)
    return {
      cursorSeq: state.cursorSeq,
      lastRun: state.lastRun,
      logs: state.logs,
      pendingTurns: pending.turns,
      dropped: pending.dropped,
    }
  }

  async stop(): Promise<void> {
    this.controller?.abort(new Error('Memory extension shut down'))
    await this.running?.catch(() => {})
  }

  /** Triggers an asynchronous auto-dream if due, tracked on the legacy session's backgroundWork. */
  schedule(session: VelaSession, logger: VelaLogger): void {
    if (!this.due()) return
    const work = this.run(session).catch((error) =>
      logger.warn(
        `[dream] ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
    session.trackWork(work)
  }

  run(
    target: VelaSession | DreamRunnerContext,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.running) return this.running
    const runnerCtx =
      'tracker' in target ? sessionRunnerContext(target) : target
    const controller = new AbortController()
    this.controller = controller
    const forward = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', forward, { once: true })
    if (signal?.aborted) forward()
    this.running = this.perform(runnerCtx, controller.signal).finally(() => {
      signal?.removeEventListener('abort', forward)
      this.running = undefined
      this.controller = undefined
    })
    return this.running
  }

  private recordAudit(
    run: Omit<DreamRunRecord, 'time'>,
    advanceCursorTo?: number,
  ): void {
    const time = Date.now()
    this.mutate((state) => {
      const cursorSeq =
        advanceCursorTo !== undefined && advanceCursorTo > state.cursorSeq
          ? advanceCursorTo
          : state.cursorSeq
      const pendingRefs = state.pendingRefs.filter((r) => r.seq > cursorSeq)
      const legacyTurns = state.legacyTurns?.filter((t) => t.seq > cursorSeq)
      return {
        ...state,
        cursorSeq,
        pendingRefs,
        ...(legacyTurns?.length ? { legacyTurns } : { legacyTurns: undefined }),
        lastRun: { ...run, time },
        logs: [...state.logs, { time, report: run.report }].slice(-MAX_LOGS),
      }
    })
  }

  private async perform(
    ctx: DreamRunnerContext,
    signal: AbortSignal,
  ): Promise<string> {
    let changes = 0
    let responseText = ''
    const initialState = this.state()
    const snapshotPending = this.pendingTurns(initialState)
    const turns = snapshotPending.turns
    const attempt = {
      inboxLength: turns.length,
      attemptMaxSeq: snapshotPending.maxSeq,
    }
    try {
      signal.throwIfAborted()
      const entries = this.store
        .list()
        .sort((a, b) => a.filePath.localeCompare(b.filePath))
      const snapshot = new Map(
        entries.map((entry) => [basename(entry.filePath), entry]),
      )
      const notes = this.selectNotes(entries, turns)
      const editable = new Set(notes.map((n) => basename(n.filePath)))
      const input = {
        triggeringSessionId: ctx.sessionId,
        index: this.store.loadIndex(8000),
        notes: notes.map(dreamNoteInput),
        inbox: turns.map(({ id, sessionId, time, user, tools }) => ({
          id,
          sessionId,
          time,
          user,
          tools,
        })),
        dropped: snapshotPending.dropped,
        findings: {
          index: this.store.indexWarnings(),
          notes: this.store.lint().map(({ entry, issues }) => ({
            filename: basename(entry.filePath),
            issues,
          })),
        },
      }
      const evidence = JSON.stringify(input)
      let prompt = evidence
      const sources = new Set(
        turns.length ? turns.map((turn) => turn.sessionId) : [ctx.sessionId],
      )
      let result: z.infer<typeof dreamResponseSchema>
      for (let round = 0; ; round++) {
        const reply = await this.ask(ctx, prompt, signal)
        responseText = reply.text
        signal.throwIfAborted()
        try {
          if (reply.incomplete)
            throw new Error(
              'Incomplete dream response or unexpected tool calls',
            )
          result = this.replyOps(reply.text, sources, editable)
          break
        } catch (error) {
          if (round) throw error
          const rejected = reply.text.trim() ? reply.text : '(empty reply)'
          prompt = `${evidence}\n\nYour previous reply was:\n${rejected}\n\n${DREAM_REPAIR.replace('{error}', () => formatDreamReplyError(error))}`
        }
      }
      const currentNotes = new Map(
        this.store.list().map((entry) => [basename(entry.filePath), entry]),
      )
      const conflicts = notes.flatMap((before) => {
        const filename = basename(before.filePath)
        const current = currentNotes.get(filename)
        return !current ||
          current.lastWriteAt !== before.lastWriteAt ||
          current.content !== before.content ||
          current.name !== before.name ||
          current.description !== before.description ||
          current.type !== before.type ||
          JSON.stringify(current.sources) !== JSON.stringify(before.sources)
          ? [filename]
          : []
      })
      for (const op of result.ops)
        if (
          op.action === 'create' &&
          (snapshot.has(op.filename) || currentNotes.has(op.filename))
        )
          conflicts.push(op.filename)
      if (conflicts.length) {
        const skipped = `Notes changed since dream read them (${conflicts.join(', ')}).`
        const report = `[dream] Skipped all ${result.ops.length} operations: ${skipped} Inbox retained; run /dream to retry.`
        this.recordAudit({ ...attempt, report, changes: 0, skipped })
        return report
      }
      const details: string[] = []
      for (const op of result.ops) {
        const before = snapshot.get(op.filename)
        if (op.action === 'delete') this.store.delete(op.filename)
        else
          this.store.save(
            {
              ...op,
              description: op.description ?? op.name,
              sources: [
                ...(before?.sources ?? []).filter(
                  (source) => source !== op.source,
                ),
                op.source,
              ].slice(-5),
            },
            op.filename,
          )
        changes++
        details.push(
          `${op.action} ${op.filename}: ${op.reason ?? 'no reason given'} (source: ${op.source})`,
        )
      }
      const report = `[dream] ${changes} changes. ${result.report}${details.length ? `\n${details.join('\n')}` : ''}`
      this.recordAudit({ ...attempt, report, changes }, snapshotPending.maxSeq)
      return report
    } catch (error) {
      const failed = formatDreamReplyError(error)
      const tail = responseText.trim().slice(-500)
      this.recordAudit({
        ...attempt,
        report: `[dream] Failed: ${failed}. Inbox retained.${tail ? `\n\nResponse tail:\n${tail}` : ''}`,
        changes,
        failed,
      })
      throw error
    }
  }

  private async ask(
    ctx: DreamRunnerContext,
    prompt: string,
    signal: AbortSignal,
  ): Promise<{ text: string; incomplete: boolean }> {
    const model = ctx.model
    const modelId = typeof model === 'string' ? model : model.modelId
    const started = performance.now()
    const response = await generateProviderText({
      model,
      instructions: DREAM_INSTRUCTIONS,
      prompt,
      abortSignal: signal,
    })
    ctx.recordUsage(
      modelId,
      normalizeUsage(response.usage),
      {
        kind: 'dream',
        usage: response.usage,
        durationMs: performance.now() - started,
      },
      { value: ctx.pricing },
    )
    return {
      text: response.text,
      incomplete:
        response.finishReason !== 'stop' || response.toolCallCount > 0,
    }
  }

  private replyOps(
    text: string,
    sources: Set<string>,
    editable: Set<string>,
  ): z.infer<typeof dreamResponseSchema> {
    const result = dreamResponseSchema.parse(parseDreamResponseJson(text))
    const targets = new Set<string>()
    for (const op of result.ops) {
      this.store.memoryFile(op.filename)
      if (!sources.has(op.source))
        throw new Error(`Invalid dream source: ${op.source}`)
      if (targets.has(op.filename))
        throw new Error(`Duplicate dream target: ${op.filename}`)
      if (op.action !== 'create' && !editable.has(op.filename))
        throw new Error(`Dream did not read the full note: ${op.filename}`)
      targets.add(op.filename)
    }
    return result
  }

  private selectNotes(
    entries: MemoryEntry[],
    turns: DreamTurn[],
  ): MemoryEntry[] {
    if (JSON.stringify(entries.map(dreamNoteInput)).length <= NOTE_BUDGET)
      return entries
    const ranked = bm25Search(
      entries,
      turns.map((turn) => turn.user).join('\n'),
      entries.length,
    )
    const selected: MemoryEntry[] = []
    let chars = 0
    const candidates = ranked.length ? ranked.map((hit) => hit.entry) : entries
    for (const entry of candidates) {
      const size = JSON.stringify(dreamNoteInput(entry)).length
      if (chars + size > NOTE_BUDGET) continue
      chars += size
      selected.push(entry)
    }
    return selected
  }
}
