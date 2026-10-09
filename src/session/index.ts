import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { silentLogger, type VelaLogger } from '../logger.ts'
import {
  fileSessionStorage,
  SESSION_FORMAT_VERSION,
  type SessionCheckpoint,
  type SessionStorage,
} from './storage.ts'
import { ToolResultStore } from './tool-results.ts'

export interface SessionState {
  messages: ModelMessage[]
  timestamps: Map<ModelMessage, number>
  summary: string
}

/** Session settings stored in the checkpoint besides messages, restored on resume. */
export type SessionSettings = Pick<
  SessionCheckpoint,
  'model' | 'thinkingLevel' | 'name'
>

const SESSION_DIR = 'sessions'

/**
 * Saving and restoring one session. Message history goes to SessionStorage (file / memory / custom);
 * long tool output and tool call history are always written under `<dir>/<id>/` (the model reads them with read_file).
 */
export class SessionStore {
  readonly results: ToolResultStore
  private readonly storage: SessionStorage
  /** Session settings written into the checkpoint on every save (model, thinking) */
  settings: () => SessionSettings = () => ({})

  constructor(
    private readonly sessionId: string,
    dir: string = SESSION_DIR,
    private readonly logger: VelaLogger = silentLogger,
    storage?: SessionStorage,
    /** Tool history lives in a temp dir (custom storage without dataDir): if it is gone on resume, start over instead of failing */
    private readonly temporaryResults = false,
  ) {
    this.storage = storage ?? fileSessionStorage(dir, logger)
    this.results = new ToolResultStore(join(dir, sessionId, 'tool-results'))
  }

  async replace(
    messages: ModelMessage[],
    timestamps: Map<ModelMessage, number>,
    summary: string,
    historyViewSequence = this.results.historyViewSequence,
  ): Promise<void> {
    const checkpoint: SessionCheckpoint = {
      type: 'checkpoint',
      version: SESSION_FORMAT_VERSION,
      timestamp: new Date().toISOString(),
      summary,
      toolHistoryId: this.results.historyId,
      toolHistorySeq: this.results.history.throughSequence,
      toolHistoryViewSeq: historyViewSequence,
      ...this.settings(),
      messages: messages.map((message) => ({
        timestamp: new Date(
          timestamps.get(message) ?? Date.now(),
        ).toISOString(),
        message,
      })),
    }
    await this.storage.save(this.sessionId, checkpoint)
  }

  /** Loads the saved session; returns an empty state if there is none. */
  async loadState(): Promise<SessionState> {
    return (
      (await this.loadSaved()) ?? {
        messages: [],
        timestamps: new Map(),
        summary: '',
      }
    )
  }

  /** Loads the saved session; returns undefined if it was never saved. */
  async loadSaved(): Promise<(SessionState & SessionSettings) | undefined> {
    const checkpoint = await this.storage.load(this.sessionId)
    if (!checkpoint) return
    const version = checkpoint.version ?? 1
    if (version > SESSION_FORMAT_VERSION)
      throw new Error(
        `Session ${this.sessionId} uses file format version ${version}, but this Vela only supports up to ${SESSION_FORMAT_VERSION}; upgrade Vela`,
      )
    const parseTimestamp = (value: string): number => {
      const parsed = Date.parse(value)
      return Number.isFinite(parsed) ? parsed : Date.now()
    }
    const messages: ModelMessage[] = []
    const timestamps = new Map<ModelMessage, number>()
    for (const stored of checkpoint.messages) {
      messages.push(stored.message)
      timestamps.set(stored.message, parseTimestamp(stored.timestamp))
    }
    if (checkpoint.toolHistoryId) {
      try {
        await this.results.resumeHistory(
          checkpoint.toolHistoryId,
          checkpoint.toolHistorySeq ?? 0,
          checkpoint.toolHistoryViewSeq,
        )
      } catch (error) {
        // The previous Vela instance's temp dir is gone: restore messages as usual, start tool call history over
        if (!this.temporaryResults) throw error
        this.logger.warn(
          `[session] Tool call history for ${this.sessionId} was in the previous temp dir and no longer exists; pass dataDir to keep it`,
        )
      }
    }
    return {
      messages,
      timestamps,
      summary: checkpoint.summary || '',
      model: checkpoint.model,
      thinkingLevel: checkpoint.thinkingLevel,
      name: checkpoint.name,
    }
  }

  async load(): Promise<ModelMessage[]> {
    return (await this.loadState()).messages
  }

  async exists(): Promise<boolean> {
    return (await this.storage.load(this.sessionId)) !== undefined
  }
}
