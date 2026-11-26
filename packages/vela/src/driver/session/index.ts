import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, VelaDatabase } from '../../db/index.ts'
import type { ThinkingLevel } from '../../providers/models/index.ts'
import { BlobStore } from '../../runtime/blobs.ts'
import { silentLogger, type VelaLogger } from '../../shared/logger.ts'
import type { CustomMessageInfo } from '../agent/events.ts'
import type { ExecutionEnv, ExecutionLocation } from '../execution/types.ts'
import type { ModelMessage } from '../messages.ts'
import type { StepRecord } from '../usage/tracker.ts'
import { loadSavedSessionFromDb } from './db-queries.ts'
import {
  computeBranchUsage,
  insertMessageRow,
  insertUsageRecord,
  queryBranchRows,
  rowToEntry,
  setSessionChannel,
  startsConversationEntry,
  updateArchivedInDb,
  updateSessionColumn,
  updateSessionLeaf,
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
import type {
  LoadedSessionContext,
  SessionState,
  SessionStoreOptions,
} from './options.ts'
import { insertClonedToolCalls, prepareSeedBranch } from './seed-clone.ts'
import {
  captureStoreSnapshot,
  restoreStoreSnapshot,
  type StoreSnapshotState,
} from './store-snapshot.ts'

export type { LoadedSessionContext, SessionState, SessionStoreOptions }

/**
 * One session's durable SQLite store (`vela.db`: `sessions`, `vela_messages`, `usage_records`).
 * Like pi, nothing is written to `vela.db` until the session has conversation content (or an
 * explicit location relocation / archive operation).
 */
export class SessionStore {
  readonly db: VelaDatabase
  readonly blobs: BlobStore
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
  private createdAt?: string
  private archivedFlag = false
  private discovered: string[] = []
  private readonly pendingBlobIds: string[] = []

  private readonly entries: SessionEntry[] = []
  private readonly entryIds = new Set<string>()
  private readonly byId = new Map<string, SessionEntry>()
  private leafId: string | null = null
  private readonly ids = new Map<ModelMessage, string>()
  private readonly entryModel = new Map<string, string>()
  private readonly entryThinking = new Map<string, ThinkingLevel>()
  private readonly entryLocations = new Map<string, ExecutionLocation>()
  private readonly pendingExtras = new Map<
    string,
    Parameters<typeof insertMessageRow>[4]
  >()
  producers = new Map<ModelMessage, string>()

  get id(): string {
    return this.sessionId
  }

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
    this.createdAt = opts.createdAt
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

    if (opts.blobsDir && !opts.ephemeral) {
      this.blobs = new BlobStore(this.db, opts.blobsDir)
    } else {
      this.transientDir = mkdtempSync(join(tmpdir(), `vela-nosession-`))
      this.blobs = new BlobStore(this.db, join(this.transientDir, 'blobs'))
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
      updateSessionColumn(this.db, this.sessionId, column, value),
    )
    this.saved()
  }

  /** Updates `sessions.discovered_tools_json` inside an existing DB transaction and syncs memory. */
  syncDiscoveredToolsInTx(
    tools: Iterable<string>,
    now = new Date().toISOString(),
  ): void {
    const list = [...tools]
    if (!this.started) {
      this.discovered = list
      return
    }
    this.db.run(
      'UPDATE sessions SET discovered_tools_json = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(list),
      now,
      this.sessionId,
    )
    this.discovered = list
  }

  async setArchived(archived: boolean): Promise<void> {
    const changed = this.db.transaction(() =>
      updateArchivedInDb(this.db, this.sessionId, archived, !this.started),
    )
    this.archivedFlag = archived
    if (changed) this.saved()
  }

  async persistLocation(location: ExecutionLocation): Promise<void> {
    if (!this.started) {
      await this.assertNew()
      this.runInTransaction(() => {
        this.location = location
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
      this.location = location
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
    const branchModel = this.modelAt(id)
    const branchThinking = this.thinkingAt(id)
    if (branchModel !== undefined) this.modelName = branchModel
    if (branchThinking !== undefined) this.thinking = branchThinking
    if (!this.started) return
    this.db.transaction(() =>
      updateSessionLeaf(
        this.db,
        this.sessionId,
        id,
        branchModel,
        branchThinking,
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
    latestAssistantUsage?: LoadedSessionContext['latestAssistantUsage']
  } {
    const context = buildSessionContext(this.entries, this.leafId, this.byId)
    this.ids.clear()
    for (const [message, id] of context.ids) this.ids.set(message, id)
    this.producers = context.producers
    const model = this.modelAt(this.leafId)
    const thinkingLevel = this.thinkingAt(this.leafId)
    const latestAssistantUsage = this.started
      ? computeBranchUsage(
          this.db,
          this.sessionId,
          this.leafId,
          context.messages,
          context.ids,
        )
      : undefined
    return {
      ...context,
      ...(model !== undefined ? { model } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      ...(latestAssistantUsage ? { latestAssistantUsage } : {}),
    }
  }

  /** Runs a synchronous DB transaction and rolls back in-memory SessionStore state if it throws. */
  runInTransaction<T>(fn: () => T): T {
    const state = this as unknown as StoreSnapshotState
    const snap = captureStoreSnapshot(state)
    this.txDepth++
    try {
      return this.db.transaction(fn)
    } catch (error) {
      restoreStoreSnapshot(state, snap)
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
    const branch = buildSessionPath(this.entries, entryId, this.byId)
    for (let i = branch.length - 1; i >= 0; i--) {
      const model = this.entryModel.get(branch[i]!.id)
      if (model !== undefined) return model
    }
    return undefined
  }

  thinkingAt(entryId: string | null): ThinkingLevel | undefined {
    if (entryId === null) return undefined
    const branch = buildSessionPath(this.entries, entryId, this.byId)
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
      targetId: this.sessionId,
      targetBlobs: this.blobs,
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
      const t = parent.store.entryThinking.get(entry.id)
      const l = parent.store.entryLocations.get(entry.id)
      if (m !== undefined) this.entryModel.set(entry.id, m)
      if (t !== undefined) this.entryThinking.set(entry.id, t)
      if (l !== undefined) this.entryLocations.set(entry.id, l)
    }
    if (prepared.entries.some(startsConversationEntry)) {
      this.runInTransaction(() => {
        this.insertSessionAndBufferedEntries(prepared.messageUsage)
        this.blobs.bindSession(prepared.blobIds, this.sessionId)
        insertClonedToolCalls(this.db, this.sessionId, this.modelName, prepared)
      })
    } else if (prepared.blobIds.length) {
      this.pendingBlobIds.push(...prepared.blobIds)
    }
  }

  private replaceEntries(entries: SessionEntry[]): void {
    this.entries.splice(0, this.entries.length, ...entries)
    this.entryIds.clear()
    this.byId.clear()
    this.entryModel.clear()
    this.entryThinking.clear()
    this.entryLocations.clear()
    this.pendingExtras.clear()
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
      if (Object.keys(extra).length > 0) this.pendingExtras.set(entry.id, extra)
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
    this.runInTransaction(() => {
      this.checkNewSync()
      this.insertSessionAndBufferedEntries()
    })
    this.saved()
  }

  async materializeUpload(
    env: ExecutionEnv,
    file: { name: string; hostPath: string; mimeType?: string },
    signal?: AbortSignal,
  ): Promise<string> {
    const { blob, path } = await this.blobs.materializeChannelUpload(
      env,
      {
        sessionId: this.sessionId,
        name: file.name,
        hostPath: file.hostPath,
        mimeType: file.mimeType,
      },
      signal,
    )
    if (!blob.sessionId) this.pendingBlobIds.push(blob.id)
    return path
  }

  private insertSessionAndBufferedEntries(
    messageUsage?: ReadonlyMap<string, Parameters<typeof insertMessageRow>[4]>,
  ): void {
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
      createdAt: this.createdAt,
    })
    if (this.pendingBlobIds.length) {
      this.blobs.bindSession(this.pendingBlobIds, this.sessionId)
      this.pendingBlobIds.length = 0
    }
    for (const entry of this.entries) {
      const extra =
        messageUsage?.get(entry.id) ?? this.pendingExtras.get(entry.id)
      this.writeEntryRow(entry, extra)
    }
    this.pendingExtras.clear()
  }

  recordUsageRecord(
    record: StepRecord,
    options: { runId?: string; messageId?: string } = {},
  ): void {
    if (!this.db.open) return
    if (record.kind !== 'dream') {
      this.ensureSessionRow()
    }
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

  async flush(): Promise<void> {
    if (!this.started && this.entries.length > 0 && this.db.open) {
      this.ensureSessionRow()
    }
  }

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
    extra?: { preservedEntryIds?: string[] },
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
      if (extra?.preservedEntryIds?.length && this.started) {
        this.db.run(
          'UPDATE vela_messages SET details_json = ? WHERE session_id = ? AND id = ?',
          JSON.stringify({ preservedEntryIds: extra.preservedEntryIds }),
          this.sessionId,
          entry.id,
        )
      }
      this.ids.set(summaryMessage, entry.id)
      return entry
    })
  }

  async loadSaved(): Promise<LoadedSessionContext | undefined> {
    const loaded = loadSavedSessionFromDb(this.db, this.sessionId)
    if (!loaded) {
      this.checked = true
      return undefined
    }
    this.seq = loaded.seq
    this.location = loaded.location
    this.sessionName = loaded.name
    this.modelName = loaded.model
    this.thinking = loaded.thinkingLevel
    this.archivedFlag = loaded.archived
    this.parentSessionId = loaded.parentSessionId
    this.createdAt = loaded.createdAt
    this.discovered = loaded.discoveredTools
    this.channel = loaded.channel
    this.replaceEntries(loaded.entries)
    for (const [k, v] of loaded.entryModel) this.entryModel.set(k, v)
    for (const [k, v] of loaded.entryThinking) this.entryThinking.set(k, v)
    for (const [k, v] of loaded.entryLocations) this.entryLocations.set(k, v)
    this.leafId = loaded.leaf
    this.ids.clear()
    for (const [message, id] of loaded.context.ids) this.ids.set(message, id)
    this.producers = loaded.context.producers
    this.started = true
    this.checked = true
    return loaded.context
  }
}
