import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { silentLogger, type VelaLogger } from '../logger.ts'
import type { ThinkingLevel } from '../models/index.ts'
import {
  type BranchSummaryEntry,
  buildSessionContext,
  buildSessionPath,
  buildSessionTree,
  type CompactionEntry,
  copyBranch,
  createEntryId,
  type NestedToolCalls,
  type NewEntry,
  SESSION_FORMAT_VERSION,
  type SessionContext,
  type SessionEntry,
  type SessionFileEntry,
  type SessionHeader,
  type SessionMessageEntry,
  type SessionTreeNode,
} from './entries.ts'
import { fileSessionStorage, type SessionStorage } from './storage.ts'
import { ToolResultStore } from './tool-results.ts'

export interface SessionState {
  messages: ModelMessage[]
  timestamps: Map<ModelMessage, number>
  summary: string
}

const SESSION_DIR = 'sessions'

/**
 * One session's append-only entry log (like pi's SessionManager). Entries are kept in memory and appended
 * to SessionStorage (file / memory / custom) in order. Like pi, nothing is written until the session has
 * a user or assistant message; then the header and everything so far go out together.
 * Long tool output and tool call history are always written under `<dir>/<id>/` (the model reads them with read_file).
 */
export class SessionStore {
  readonly results: ToolResultStore
  private readonly storage: SessionStorage
  private header?: SessionHeader
  private readonly entries: SessionEntry[] = []
  private readonly entryIds = new Set<string>()
  private readonly byId = new Map<string, SessionEntry>()
  /** The entry new entries are appended under (like pi's leaf pointer); null before the first entry */
  private leafId: string | null = null
  /** Entry id of each message in the model context */
  private readonly ids = new Map<ModelMessage, string>()
  /** The header has gone into the write queue */
  private started = false
  /** Whether storage was checked for (or loaded) an earlier session with this id */
  private checked = false
  /** Entries waiting to be written, in order */
  private readonly pending: SessionFileEntry[] = []
  private writing: Promise<void> = Promise.resolve()
  private lastError: unknown

  constructor(
    private readonly sessionId: string,
    dir: string = SESSION_DIR,
    private readonly logger: VelaLogger = silentLogger,
    storage?: SessionStorage,
    /** Tool history lives in a temp dir (custom storage without dataDir): if it is gone on resume, start over instead of failing */
    private readonly temporaryResults = false,
    private readonly cwd?: string,
  ) {
    this.storage = storage ?? fileSessionStorage(dir, logger)
    this.results = new ToolResultStore(join(dir, sessionId, 'tool-results'))
  }

  /** A copy of the session's entries in append order (header excluded). */
  getEntries(): SessionEntry[] {
    return structuredClone(this.entries)
  }

  /** The current leaf (like pi's getLeafId); null when the session has no entries or the leaf was reset. */
  getLeafId(): string | null {
    return this.leafId
  }

  /** A copy of one entry. */
  getEntry(id: string): SessionEntry | undefined {
    const entry = this.byId.get(id)
    return entry && structuredClone(entry)
  }

  /** Copies of the entries from the root to `fromId` (default: the current leaf), like pi's getBranch. */
  getBranch(fromId: string | null = this.leafId): SessionEntry[] {
    return structuredClone(buildSessionPath(this.entries, fromId, this.byId))
  }

  /** The session as a tree (copies), like pi's getTree. */
  getTree(): SessionTreeNode[] {
    return buildSessionTree(structuredClone(this.entries))
  }

  /** Session id this one was forked from, if any. */
  get parentSession(): string | undefined {
    return this.header?.parentSession
  }

  /**
   * Moves the leaf (like pi's branch / resetLeaf): the next entry becomes a child of `id`, or a new root
   * when `id` is null. Entries are never changed or removed.
   */
  branch(id: string | null): void {
    if (id !== null && !this.byId.has(id))
      throw new Error(`Entry ${id} is not in the session`)
    this.leafId = id
  }

  /** Moves the leaf to `id` and appends a summary of the branch left there (like pi's branchWithSummary). */
  branchWithSummary(id: string | null, summary: string): BranchSummaryEntry {
    const fromId = this.leafId ?? 'root'
    this.branch(id)
    return this.append<BranchSummaryEntry>({
      type: 'branch_summary',
      fromId,
      summary,
    })
  }

  /** Sets or clears (undefined / empty) the label of an entry (like pi's appendLabelChange). */
  appendLabelChange(targetId: string, label: string | undefined): void {
    if (!this.byId.has(targetId))
      throw new Error(`Entry ${targetId} is not in the session`)
    this.append({ type: 'label', targetId, label: label || undefined })
  }

  /** Rebuilds the model context of the current branch and points context messages at their entries. */
  buildContext(): SessionContext {
    const context = buildSessionContext(this.entries, this.leafId, this.byId)
    this.ids.clear()
    for (const [message, id] of context.ids) this.ids.set(message, id)
    return context
  }

  /**
   * Starts this (new, never written) session as a copy of another session's branch (fork / clone, like
   * pi's createBranchedSession). The parent's tool call history is copied so summaries that point into it
   * keep working. Written right away when the branch has a conversation.
   */
  async seedFrom(
    branch: SessionEntry[],
    parent: { id: string; results: ToolResultStore },
  ): Promise<void> {
    // Setup entries the new session holds in memory are replaced by the branch's own
    if (this.started)
      throw new Error('Only a new session can be seeded from another branch')
    await this.checkNew()
    const entries = copyBranch(structuredClone(branch))
    const context = buildSessionContext(entries)
    const source = parent.results.history.path
    const target = join(
      this.results.dir,
      '..',
      this.results.historyId,
      'tool-history.jsonl',
    )
    try {
      await mkdir(join(target, '..'), { recursive: true, mode: 0o700 })
      await copyFile(source, target)
    } catch (error) {
      // The parent has not run a tool yet: nothing to copy
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await this.results.resumeHistory(
      this.results.historyId,
      0,
      context.toolHistoryViewSeq,
    )
    this.header = {
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: this.sessionId,
      timestamp: new Date().toISOString(),
      ...(this.cwd ? { cwd: this.cwd } : {}),
      toolHistoryId: this.results.historyId,
      parentSession: parent.id,
    }
    this.replaceEntries(entries)
    if (
      entries.some(
        (entry) =>
          entry.type === 'message' &&
          (entry.message.role === 'user' || entry.message.role === 'assistant'),
      )
    ) {
      this.started = true
      this.pending.push(this.header, ...this.entries)
      this.writing = this.writing.then(() => this.write())
    }
  }

  private replaceEntries(entries: SessionEntry[]): void {
    this.entries.splice(0, this.entries.length, ...entries)
    this.entryIds.clear()
    this.byId.clear()
    for (const entry of entries) {
      this.entryIds.add(entry.id)
      this.byId.set(entry.id, entry)
    }
    this.leafId = entries.at(-1)?.id ?? null
  }

  /** Entry id of a message in the current context. */
  idOf(message: ModelMessage): string | undefined {
    return this.ids.get(message)
  }

  private append<T extends SessionEntry>(input: NewEntry<T>): T {
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
    this.persist(entry)
    return entry
  }

  private persist(entry: SessionEntry): void {
    if (!this.started) {
      // Like pi: setup entries (model, thinking level, name) stay in memory until there is a conversation
      if (
        entry.type !== 'message' ||
        (entry.message.role !== 'user' && entry.message.role !== 'assistant')
      )
        return
      this.started = true
      this.header ??= {
        type: 'session',
        version: SESSION_FORMAT_VERSION,
        id: this.sessionId,
        timestamp: new Date().toISOString(),
        ...(this.cwd ? { cwd: this.cwd } : {}),
        toolHistoryId: this.results.historyId,
      }
      this.pending.push(this.header, ...this.entries)
    } else this.pending.push(entry)
    this.writing = this.writing.then(() => this.write())
  }

  /** Appends what is pending; on failure keeps it for the next attempt (never rejects). */
  private async write(): Promise<void> {
    const batch = this.pending.splice(0)
    if (!batch.length) return
    try {
      // A header starts a new session: check storage first (also when messages were appended without prompt())
      if (batch[0]?.type === 'session') await this.checkNew()
      await this.storage.append(this.sessionId, batch)
      this.lastError = undefined
    } catch (error) {
      this.pending.unshift(...batch)
      this.lastError = error
    }
  }

  /**
   * Waits until every entry so far is written (retrying ones that failed before). Rejects with the
   * storage error if some are still unwritten.
   */
  async flush(): Promise<void> {
    this.writing = this.writing.then(() => this.write())
    await this.writing
    // Entries appended while flushing are not failures; they go out with the next write
    if (this.pending.length && this.lastError !== undefined)
      throw this.lastError
  }

  /**
   * Before the first message of a session that was not resumed: storage must not already hold a session
   * with this id (appending to it would mix two conversations).
   */
  async assertNew(): Promise<void> {
    // Already writing this session (started by append() before the first prompt): the write checks before the header
    if (this.started) return
    await this.checkNew()
  }

  private async checkNew(): Promise<void> {
    if (this.checked) return
    if (await this.storage.load(this.sessionId))
      throw new Error(
        `Session ${this.sessionId} already has saved history: call resume() to continue it, or use another session id`,
      )
    this.checked = true
  }

  /** Appends a message (with the stop reason of an aborted / failed assistant message, or a tool message's nested calls). */
  appendMessage(
    message: ModelMessage,
    extra: {
      stopReason?: 'aborted' | 'error'
      nestedCalls?: Record<string, NestedToolCalls>
    } = {},
  ): SessionMessageEntry {
    const entry = this.append<SessionMessageEntry>({
      type: 'message',
      message,
      ...(extra.stopReason ? { stopReason: extra.stopReason } : {}),
      ...(extra.nestedCalls && Object.keys(extra.nestedCalls).length
        ? { nestedCalls: extra.nestedCalls }
        : {}),
    })
    if (!extra.stopReason) this.ids.set(message, entry.id)
    return entry
  }

  appendModelChange(model: string): void {
    this.append({ type: 'model_change', model })
  }

  appendThinkingLevelChange(thinkingLevel: ThinkingLevel): void {
    this.append({ type: 'thinking_level_change', thinkingLevel })
  }

  appendSessionInfo(name: string | undefined): void {
    this.append({ type: 'session_info', ...(name ? { name } : {}) })
  }

  /** Replaces a context message's content (`original` must be in the context); `replacement` takes over its entry id. */
  appendContextEdit(original: ModelMessage, replacement: ModelMessage): void {
    const targetId = this.ids.get(original)
    if (!targetId)
      throw new Error('Cannot edit a message that is not in the session')
    this.append({
      type: 'context_edit',
      targetId,
      replacement: { content: replacement.content },
    })
    this.ids.set(replacement, targetId)
  }

  /** Records a summary: the context becomes `summaryMessage` followed by the messages from `firstKept` on. */
  appendCompaction(
    summaryMessage: ModelMessage,
    summary: string,
    firstKept: ModelMessage | undefined,
    tokensBefore: number,
    toolHistoryViewSeq?: number,
  ): CompactionEntry {
    const firstKeptEntryId = firstKept ? this.ids.get(firstKept) : undefined
    if (firstKept && !firstKeptEntryId)
      throw new Error('The first kept message is not in the session')
    const entry = this.append<CompactionEntry>({
      type: 'compaction',
      summary,
      firstKeptEntryId: firstKeptEntryId ?? '',
      tokensBefore,
      ...(toolHistoryViewSeq === undefined ? {} : { toolHistoryViewSeq }),
    })
    // Kept nothing: the compaction keeps itself (like pi); set before the queued write runs
    if (!firstKeptEntryId) entry.firstKeptEntryId = entry.id
    this.ids.set(summaryMessage, entry.id)
    return entry
  }

  /** Loads the saved session; returns undefined if it was never saved. Replaces the entries in memory. */
  async loadSaved(): Promise<SessionContext | undefined> {
    const loaded = await this.storage.load(this.sessionId)
    this.checked = true
    if (!loaded?.length) return
    const header = loaded[0] as SessionHeader
    if (header.type !== 'session')
      throw new Error(`Session ${this.sessionId} has no session header`)
    const version = header.version ?? 1
    if (version > SESSION_FORMAT_VERSION)
      throw new Error(
        `Session ${this.sessionId} uses file format version ${version}, but this Vela only supports up to ${SESSION_FORMAT_VERSION}; upgrade Vela`,
      )
    if (version < SESSION_FORMAT_VERSION)
      throw new Error(
        `Session ${this.sessionId} uses file format version ${version}; its storage must convert it (see migrateSessionV1)`,
      )
    // A write retried after it failed part way can repeat entries: the first copy of each id counts
    const seen = new Set<string>()
    const entries = (loaded.slice(1) as SessionEntry[]).filter(
      (entry) =>
        typeof entry.id !== 'string' ||
        (!seen.has(entry.id) && !!seen.add(entry.id)),
    )
    // Like pi: the leaf is the last entry
    const context = buildSessionContext(entries, entries.at(-1)?.id ?? null)
    if (header.toolHistoryId) {
      try {
        await this.results.resumeHistory(
          header.toolHistoryId,
          0,
          context.toolHistoryViewSeq,
        )
      } catch (error) {
        // The previous Vela instance's temp dir is gone: restore messages as usual, start tool call history over
        if (!this.temporaryResults) throw error
        this.logger.warn(
          `[session] Tool call history for ${this.sessionId} was in the previous temp dir and no longer exists; pass dataDir to keep it`,
        )
      }
    }
    this.header = header
    this.replaceEntries(entries)
    this.ids.clear()
    for (const [message, id] of context.ids) this.ids.set(message, id)
    this.started = true
    this.pending.length = 0
    return context
  }
}
