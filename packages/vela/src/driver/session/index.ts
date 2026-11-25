import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, VelaDatabase } from '../../db/index.ts'
import type { ThinkingLevel } from '../../providers/models/index.ts'
import { silentLogger, type VelaLogger } from '../../shared/logger.ts'
import type { CustomMessageInfo } from '../agent/events.ts'
import { validateStoredLocation } from '../execution/location.ts'
import type { ExecutionEnv, ExecutionLocation } from '../execution/types.ts'
import type { ModelMessage } from '../messages.ts'
import type { StepRecord } from '../usage/tracker.ts'
import {
  collectRowMetadata,
  computeLatestAssistantUsage,
  getSessionChannel,
  insertMessageRow,
  insertUsageRecord,
  loadAllSessionRows,
  loadSessionMeta,
  queryBranchRows,
  rowToEntry,
  setSessionChannel,
  startsConversationEntry,
  updateArchivedInDb,
  upsertSessionRecord,
} from './db-store.ts'
import {
  type BashExecutionEntry,
  type BranchSummaryEntry,
  buildSessionContext,
  buildSessionPath,
  buildSessionTree,
  type CompactionEntry,
  type CustomEntry,
  type CustomMessageEntry,
  createEntryId,
  type NewEntry,
  type SessionContext,
  type SessionEntry,
  type SessionMessageEntry,
  type SessionTreeNode,
} from './entries.ts'
import { insertClonedToolCalls, prepareSeedBranch } from './seed-clone.ts'
import { SessionUploads } from './uploads.ts'

export interface SessionState {
  messages: ModelMessage[]
  timestamps: Map<ModelMessage, number>
  summary: string
}

export interface LoadedSessionContext extends SessionContext {
  channel?: string
  location?: ExecutionLocation
  name?: string
  model?: string
  thinkingLevel?: ThinkingLevel
  discoveredTools: string[]
  latestAssistantUsage?: {
    inputTokens: number
    outputTokens: number
    trailingMessages: ModelMessage[]
  }
}

export interface SessionStoreOptions {
  uploadsDir?: string
  logger?: VelaLogger
  ephemeral?: boolean
  cwd?: string
  location?: ExecutionLocation
  onSaved?: () => void
}

/**
 * One session's durable SQLite store (`vela.db`: `sessions`, `vela_messages`, `usage_records`).
 * Like pi, nothing is written to `vela.db` until the session has conversation content (or an
 * explicit location relocation / archive operation).
 */
export class SessionStore {
  readonly db: VelaDatabase
  readonly uploads: SessionUploads
  private readonly ownsDb: boolean
  private transientDir?: string
  private readonly logger: VelaLogger
  private readonly cwd?: string
  private location?: ExecutionLocation
  private readonly onSaved?: () => void

  private started = false
  private checked = false
  private seq = 0
  private txDepth = 0
  private pendingSave = false
  private channel?: string
  private sessionName?: string
  private modelName?: string
  private thinking?: ThinkingLevel
  private parentSessionId?: string
  private archivedFlag = false
  private discovered: string[] = []

  private readonly entries: SessionEntry[] = []
  private readonly entryIds = new Set<string>()
  private readonly byId = new Map<string, SessionEntry>()
  private leafId: string | null = null
  private readonly ids = new Map<ModelMessage, string>()
  private readonly entryModel = new Map<string, string>()
  private readonly entryThinking = new Map<string, ThinkingLevel>()
  private readonly entryLocations = new Map<string, ExecutionLocation>()
  producers = new Map<ModelMessage, string>()

  constructor(
    private readonly sessionId: string,
    dbOrDir: VelaDatabase | string = ':memory:',
    optionsOrLogger?: SessionStoreOptions | VelaLogger,
    extra?: SessionStoreOptions,
  ) {
    const opts: SessionStoreOptions =
      optionsOrLogger && 'debug' in optionsOrLogger
        ? { logger: optionsOrLogger, ...extra }
        : { ...(optionsOrLogger ?? {}), ...extra }

    this.logger = opts.logger ?? silentLogger
    this.cwd = opts.cwd
    this.location = opts.location
    this.onSaved = opts.onSaved

    if (dbOrDir instanceof VelaDatabase) {
      this.db = dbOrDir
      this.ownsDb = false
    } else {
      const dbPath =
        dbOrDir === ':memory:' ? ':memory:' : join(dbOrDir, 'vela.db')
      this.db = openDatabase({ path: dbPath })
      this.ownsDb = true
    }

    if (opts.uploadsDir && !opts.ephemeral) {
      this.uploads = new SessionUploads(sessionId, opts.uploadsDir)
    } else {
      this.transientDir = mkdtempSync(join(tmpdir(), `vela-nosession-`))
      this.uploads = new SessionUploads(
        sessionId,
        join(this.transientDir, 'upload-sources'),
      )
    }
  }

  get persistencePath(): string {
    return this.db.path
  }

  get isMemory(): boolean {
    return this.db.path === ':memory:'
  }

  /** Transient tool-result spill directory for ephemeral sessions, deleted on close. */
  get transientSpillDir(): string | undefined {
    return this.transientDir
      ? join(this.transientDir, 'tool-results')
      : undefined
  }

  /** Deletes transient upload metadata directory (and closes owned DB). */
  releaseTransient(): void {
    const dir = this.transientDir
    if (dir) {
      this.transientDir = undefined
      rmSync(dir, { recursive: true, force: true })
    }
    if (this.ownsDb && this.db.open) this.db.close()
  }

  getEntries(): SessionEntry[] {
    return structuredClone(this.entries)
  }

  setChannel(name: string): void {
    if (this.channel === name) return
    this.channel = name
    if (this.started) {
      this.db.transaction(() =>
        setSessionChannel(this.db, this.sessionId, name),
      )
      this.saved()
    }
  }

  setModelChoice(model: string): void {
    if (this.modelName === model) return
    this.modelName = model
    this.updateStartedColumn('model', model)
  }

  setThinkingLevelChoice(level: ThinkingLevel): void {
    if (this.thinking === level) return
    this.thinking = level
    this.updateStartedColumn('thinking_level', level)
  }

  setSessionName(name: string | undefined): void {
    if (this.sessionName === name) return
    this.sessionName = name
    this.updateStartedColumn('name', name ?? null)
  }

  setDiscoveredTools(tools: Iterable<string>): void {
    const list = [...tools]
    if (JSON.stringify(list) === JSON.stringify(this.discovered)) return
    this.discovered = list
    this.updateStartedColumn('discovered_tools_json', JSON.stringify(list))
  }

  private updateStartedColumn(
    column: 'model' | 'thinking_level' | 'name' | 'discovered_tools_json',
    value: string | null,
  ): void {
    if (!this.started) return
    this.db.transaction(() =>
      this.db.run(
        `UPDATE sessions SET ${column} = ?, updated_at = ? WHERE id = ?`,
        value,
        new Date().toISOString(),
        this.sessionId,
      ),
    )
    this.saved()
  }

  /** Updates `sessions.discovered_tools_json` inside an existing DB transaction and syncs memory. */
  syncDiscoveredToolsInTx(
    tools: Iterable<string>,
    now = new Date().toISOString(),
  ): void {
    const list = [...tools]
    this.discovered = list
    if (!this.started) return
    this.db.run(
      'UPDATE sessions SET discovered_tools_json = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(list),
      now,
      this.sessionId,
    )
  }

  async setArchived(archived: boolean): Promise<void> {
    const changed = this.db.transaction(() =>
      updateArchivedInDb(this.db, this.sessionId, archived, !this.started),
    )
    this.archivedFlag = archived
    if (changed) this.saved()
  }

  async persistLocation(location: ExecutionLocation): Promise<void> {
    this.location = location
    if (!this.started) {
      await this.assertNew()
      this.db.transaction(() => {
        this.insertSessionAndBufferedEntries()
      })
    } else {
      this.db.transaction(() => {
        this.db.run(
          'UPDATE sessions SET location_json = ?, updated_at = ? WHERE id = ?',
          JSON.stringify(location),
          new Date().toISOString(),
          this.sessionId,
        )
      })
    }
    this.saved()
  }

  getLeafId(): string | null {
    return this.leafId
  }

  getEntry(id: string): SessionEntry | undefined {
    const entry = this.byId.get(id)
    return entry && structuredClone(entry)
  }

  getBranch(fromId: string | null = this.leafId): SessionEntry[] {
    if (this.started && this.db.open) {
      const rows = queryBranchRows(this.db, this.sessionId, fromId)
      if (rows.length || fromId === null) {
        return structuredClone(rows.map(rowToEntry))
      }
    }
    return structuredClone(buildSessionPath(this.entries, fromId, this.byId))
  }

  getTree(): SessionTreeNode[] {
    return buildSessionTree(structuredClone(this.entries))
  }

  get parentSession(): string | undefined {
    return this.parentSessionId
  }

  branch(id: string | null): void {
    if (id !== null && !this.byId.has(id))
      throw new Error(`Entry ${id} is not in the session`)
    this.leafId = id
    if (!this.started) return
    this.db.transaction(() =>
      this.db.run(
        'UPDATE sessions SET leaf_message_id = ?, updated_at = ? WHERE id = ?',
        id,
        new Date().toISOString(),
        this.sessionId,
      ),
    )
    this.saved()
  }

  branchWithSummary(id: string | null, summary: string): BranchSummaryEntry {
    const fromId = this.leafId ?? 'root'
    this.branch(id)
    return this.append<BranchSummaryEntry>({
      type: 'branch_summary',
      fromId,
      summary,
    })
  }

  appendLabelChange(targetId: string, label: string | undefined): void {
    const entry = this.byId.get(targetId)
    if (!entry) throw new Error(`Entry ${targetId} is not in the session`)
    const normalized = label || undefined
    if (normalized) entry.label = normalized
    else delete entry.label
    if (!this.started) return
    this.db.transaction(() => {
      this.db.run(
        'UPDATE vela_messages SET label = ? WHERE session_id = ? AND id = ?',
        normalized ?? null,
        this.sessionId,
        targetId,
      )
      this.db.run(
        'UPDATE sessions SET updated_at = ? WHERE id = ?',
        new Date().toISOString(),
        this.sessionId,
      )
    })
    this.saved()
  }

  buildContext(): SessionContext & {
    model?: string
    thinkingLevel?: ThinkingLevel
  } {
    const context = buildSessionContext(this.entries, this.leafId, this.byId)
    this.ids.clear()
    for (const [message, id] of context.ids) this.ids.set(message, id)
    this.producers = context.producers
    const model = this.modelAt(this.leafId)
    const thinkingLevel = this.thinkingAt(this.leafId)
    return {
      ...context,
      ...(model !== undefined ? { model } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    }
  }

  /** Runs a synchronous DB transaction and rolls back in-memory SessionStore state if it throws. */
  runInTransaction<T>(fn: () => T): T {
    const snap = {
      len: this.entries.length,
      leaf: this.leafId,
      seq: this.seq,
      started: this.started,
      checked: this.checked,
      producers: new Map(this.producers),
      ids: new Map(this.ids),
      entryModel: new Map(this.entryModel),
      entryThinking: new Map(this.entryThinking),
      entryLocations: new Map(this.entryLocations),
      entryIds: new Set(this.entryIds),
      byId: new Map(this.byId),
    }
    this.txDepth++
    try {
      return this.db.transaction(fn)
    } catch (error) {
      this.entries.length = snap.len
      this.leafId = snap.leaf
      this.seq = snap.seq
      this.started = snap.started
      this.checked = snap.checked
      this.producers = snap.producers
      for (const [t, s] of [
        [this.ids, snap.ids],
        [this.entryModel, snap.entryModel],
        [this.entryThinking, snap.entryThinking],
        [this.entryLocations, snap.entryLocations],
        [this.byId, snap.byId],
      ] as const) {
        ;(t as Map<unknown, unknown>).clear()
        for (const [k, v] of s) (t as Map<unknown, unknown>).set(k, v)
      }
      this.entryIds.clear()
      for (const id of snap.entryIds) this.entryIds.add(id)
      this.pendingSave = false
      throw error
    } finally {
      this.txDepth--
      if (this.txDepth === 0 && this.pendingSave) {
        this.pendingSave = false
        this.saved()
      }
    }
  }

  modelAt(entryId: string | null): string | undefined {
    if (entryId === null) return undefined
    const branch = this.getBranch(entryId)
    for (let i = branch.length - 1; i >= 0; i--) {
      const model = this.entryModel.get(branch[i]!.id)
      if (model !== undefined) return model
    }
    return undefined
  }

  thinkingAt(entryId: string | null): ThinkingLevel | undefined {
    if (entryId === null) return undefined
    const branch = this.getBranch(entryId)
    for (let i = branch.length - 1; i >= 0; i--) {
      const level = this.entryThinking.get(branch[i]!.id)
      if (level !== undefined) return level
    }
    return undefined
  }

  loadedTools(): string[] {
    return [...this.discovered]
  }

  async seedFrom(
    branch: SessionEntry[],
    parent: { id: string; store: SessionStore; location?: ExecutionLocation },
    resolveEnv: () => Promise<ExecutionEnv>,
    spillOptions: {
      parentSpillDir?: string
      spillDir?: string
      resolveSourceEnv?: (location?: ExecutionLocation) => Promise<ExecutionEnv>
    } = {},
  ): Promise<void> {
    if (this.started)
      throw new Error('Only a new session can be seeded from another branch')
    await this.assertNew()
    const prepared = await prepareSeedBranch({
      db: this.db,
      branch,
      parentId: parent.id,
      parentUploads: parent.store.uploads,
      targetUploads: this.uploads,
      resolveEnv,
      resolveSourceEnv: spillOptions.resolveSourceEnv,
      parentLocation: parent.location,
      targetLocation: this.location,
      entryLocations: parent.store.entryLocations,
      parentSpillDir: spillOptions.parentSpillDir,
      spillDir: spillOptions.spillDir,
    })
    this.parentSessionId = parent.id
    this.discovered = [...parent.store.discovered]
    this.replaceEntries(prepared.entries)
    for (const entry of prepared.entries) {
      const m = parent.store.entryModel.get(entry.id)
      if (m !== undefined) this.entryModel.set(entry.id, m)
      const t = parent.store.entryThinking.get(entry.id)
      if (t !== undefined) this.entryThinking.set(entry.id, t)
      const l = parent.store.entryLocations.get(entry.id)
      if (l !== undefined) this.entryLocations.set(entry.id, l)
    }
    if (prepared.entries.some(startsConversationEntry)) {
      this.runInTransaction(() => {
        this.insertSessionAndBufferedEntries()
        insertClonedToolCalls(this.db, this.sessionId, this.modelName, prepared)
      })
    }
  }

  private replaceEntries(entries: SessionEntry[]): void {
    this.entries.splice(0, this.entries.length, ...entries)
    this.entryIds.clear()
    this.byId.clear()
    this.entryModel.clear()
    this.entryThinking.clear()
    this.entryLocations.clear()
    for (const entry of entries) {
      this.entryIds.add(entry.id)
      this.byId.set(entry.id, entry)
    }
    this.leafId = entries.at(-1)?.id ?? null
  }

  idOf(message: ModelMessage): string | undefined {
    return this.ids.get(message)
  }

  private append<T extends SessionEntry>(
    input: NewEntry<T>,
    extra: Parameters<typeof insertMessageRow>[4] = {},
  ): T {
    return this.runInTransaction(() => {
      const id = createEntryId(this.entryIds)
      this.entryIds.add(id)
      const entry = {
        ...input,
        id,
        parentId: this.leafId,
        timestamp: new Date().toISOString(),
      } as unknown as T
      this.entries.push(entry)
      this.byId.set(id, entry)
      this.leafId = id
      if (this.modelName !== undefined) this.entryModel.set(id, this.modelName)
      if (this.thinking !== undefined) this.entryThinking.set(id, this.thinking)
      if (extra.location !== undefined)
        this.entryLocations.set(id, extra.location)
      this.persistEntry(entry, extra)
      return entry
    })
  }

  private writeEntryRow(
    entry: SessionEntry,
    extra: Parameters<typeof insertMessageRow>[4] = {},
  ): void {
    insertMessageRow(this.db, this.sessionId, entry, ++this.seq, {
      ...extra,
      choice: {
        model: this.entryModel.get(entry.id),
        thinkingLevel: this.entryThinking.get(entry.id),
      },
      location: extra.location ?? this.entryLocations.get(entry.id),
    })
  }

  private persistEntry(
    entry: SessionEntry,
    extra: Parameters<typeof insertMessageRow>[4] = {},
  ): void {
    if (!this.started) {
      if (!startsConversationEntry(entry)) return
      this.checkNewSync()
      this.db.transaction(() => this.insertSessionAndBufferedEntries())
      this.saved()
      return
    }
    this.db.transaction(() => {
      this.writeEntryRow(entry, extra)
      this.db.run(
        'UPDATE sessions SET leaf_message_id = ?, updated_at = ? WHERE id = ?',
        this.leafId,
        entry.timestamp,
        this.sessionId,
      )
    })
    this.saved()
  }

  ensureSessionRow(): void {
    if (this.started) return
    this.checkNewSync()
    this.db.transaction(() => this.insertSessionAndBufferedEntries())
    this.saved()
  }

  private insertSessionAndBufferedEntries(): void {
    this.started = true
    this.checked = true
    const location =
      this.location ??
      (this.cwd ? { environment: 'local' as const, cwd: this.cwd } : undefined)
    upsertSessionRecord(this.db, {
      sessionId: this.sessionId,
      name: this.sessionName,
      archived: this.archivedFlag,
      model: this.modelName,
      thinkingLevel: this.thinking,
      location,
      leafId: this.leafId,
      discoveredTools: this.discovered,
      parentSessionId: this.parentSessionId,
      channel: this.channel,
    })
    for (const entry of this.entries) this.writeEntryRow(entry)
  }

  recordUsageRecord(
    record: StepRecord,
    options: { runId?: string; messageId?: string } = {},
  ): void {
    if (!this.db.open) return
    this.ensureSessionRow()
    insertUsageRecord(this.db, this.sessionId, record, options)
  }

  private saved(): void {
    if (this.txDepth > 0) {
      this.pendingSave = true
      return
    }
    try {
      this.onSaved?.()
    } catch (error) {
      this.logger.error(
        `[session:${this.sessionId}] save observer failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async flush(): Promise<void> {}

  async assertNew(): Promise<void> {
    if (!this.started) this.checkNewSync()
  }

  private checkNewSync(): void {
    if (this.checked) return
    if (
      this.db.get<{ id: string }>(
        'SELECT id FROM sessions WHERE id = ?',
        this.sessionId,
      )
    ) {
      throw new Error(
        `Session ${this.sessionId} already has saved history: call resume() to continue it, or use another session id`,
      )
    }
    this.checked = true
  }

  appendMessage(
    message: ModelMessage,
    extra: Parameters<typeof insertMessageRow>[4] & {
      stopReason?: 'aborted' | 'error'
      details?: Record<string, unknown>
      producedBy?: string
    } = {},
  ): SessionMessageEntry {
    const entry = this.append<SessionMessageEntry>(
      {
        type: 'message',
        message,
        ...(message.role === 'assistant' && extra.producedBy
          ? { producedBy: extra.producedBy }
          : {}),
        ...(extra.stopReason ? { stopReason: extra.stopReason } : {}),
        ...(extra.details && Object.keys(extra.details).length
          ? { details: extra.details }
          : {}),
      },
      extra,
    )
    if (!extra.stopReason) this.ids.set(message, entry.id)
    if (entry.producedBy) this.producers.set(message, entry.producedBy)
    return entry
  }

  appendCustomMessage(
    message: ModelMessage & { role: 'user' },
    info: CustomMessageInfo,
  ): CustomMessageEntry {
    const entry = this.append<CustomMessageEntry>({
      type: 'custom_message',
      customType: info.customType,
      content: message.content,
      display: info.display,
      ...(info.details === undefined ? {} : { details: info.details }),
    })
    this.ids.set(message, entry.id)
    return entry
  }

  appendCustom(customType: string, data?: unknown): CustomEntry {
    return this.append<CustomEntry>({
      type: 'custom',
      customType,
      ...(data === undefined ? {} : { data }),
    })
  }

  appendBashExecution(
    execution: NewEntry<BashExecutionEntry>,
    message?: ModelMessage,
  ): BashExecutionEntry {
    const location =
      this.location ??
      (this.cwd ? { environment: 'local' as const, cwd: this.cwd } : undefined)
    const entry = this.append<BashExecutionEntry>(execution, { location })
    if (message) this.ids.set(message, entry.id)
    return entry
  }

  appendCompaction(
    summaryMessage: ModelMessage,
    summary: string,
    firstKept: ModelMessage | undefined,
    tokensBefore: number,
  ): CompactionEntry {
    const firstKeptEntryId = firstKept ? this.ids.get(firstKept) : undefined
    if (firstKept && !firstKeptEntryId)
      throw new Error('The first kept message is not in the session')
    return this.runInTransaction(() => {
      const entry = this.append<CompactionEntry>({
        type: 'compaction',
        summary,
        firstKeptEntryId: firstKeptEntryId ?? '',
        tokensBefore,
      })
      if (!firstKeptEntryId) {
        entry.firstKeptEntryId = entry.id
        if (this.started) {
          this.db.run(
            'UPDATE vela_messages SET first_kept_id = ? WHERE session_id = ? AND id = ?',
            entry.id,
            this.sessionId,
            entry.id,
          )
        }
      }
      this.ids.set(summaryMessage, entry.id)
      return entry
    })
  }

  async loadSaved(): Promise<LoadedSessionContext | undefined> {
    const meta = loadSessionMeta(this.db, this.sessionId)
    if (!meta.row) {
      this.checked = true
      return undefined
    }
    const rows = loadAllSessionRows(this.db, this.sessionId)
    const entries = rows.map(rowToEntry)
    this.seq = rows.reduce((max, r) => Math.max(max, r.seq), 0)

    const location = meta.row.location_json
      ? (JSON.parse(meta.row.location_json) as ExecutionLocation)
      : undefined
    if (location !== undefined) validateStoredLocation(location)

    const leaf = meta.row.leaf_message_id
    const byId = new Map(entries.map((e) => [e.id, e]))
    const context = buildSessionContext(entries, leaf, byId)

    // Restore latest assistant usage along the active branch for TokenTracker calibration (#536 #3)
    const activeIds = new Set(
      buildSessionPath(entries, leaf, byId).map((e) => e.id),
    )
    const latestAssistantUsage = computeLatestAssistantUsage(
      rows,
      activeIds,
      context.messages,
      context.ids,
    )

    this.location = location
    this.sessionName = meta.row.name ?? undefined
    this.modelName = meta.model
    this.thinking = meta.thinkingLevel
    this.archivedFlag = meta.row.archived === 1
    this.parentSessionId = meta.row.parent_session_id ?? undefined
    this.discovered = meta.discoveredTools
    this.channel = meta.channel ?? getSessionChannel(this.db, this.sessionId)
    this.replaceEntries(entries)
    collectRowMetadata(
      rows,
      this.entryModel,
      this.entryThinking,
      this.entryLocations,
    )
    this.leafId = leaf
    this.ids.clear()
    for (const [message, id] of context.ids) this.ids.set(message, id)
    this.producers = context.producers
    this.started = true
    this.checked = true

    return {
      ...context,
      channel: this.channel,
      location,
      name: this.sessionName,
      model: this.modelName,
      thinkingLevel: this.thinking,
      discoveredTools: [...this.discovered],
      latestAssistantUsage,
    }
  }
}
