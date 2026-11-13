import type {
  ChannelHost,
  ChannelSessionSnapshot,
  IncomingMessage,
} from './types.ts'

/** Local project channel. A token enables authenticated loopback HTTP/SSE; omitted means no listener. */
export interface LocalOptions {
  token?: string
  /** Fixed loopback listener; default 8788. Zero selects an ephemeral SDK port. */
  port?: number
  timezone?: string
}
export interface LocalProject {
  id: string
  channel: 'local'
  cwd: string
  name: string
  sessionId: string
}
export interface LocalMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  text: string
  createdAt: string
  /** Correlation only: repeating a POST admits another message, not a deduplicated retry. */
  clientMessageId?: string
}
export interface LocalSession extends ChannelSessionSnapshot {
  channel: 'local'
}
export interface LocalProgress {
  stage: 'tool' | 'retry' | 'compaction'
  tool?: string
  state?: 'started' | 'finished' | 'failed'
}
export type LocalEventData =
  | {
      type: 'reset'
      data: { reason: 'connected'; reload: ['sessions', 'messages'] }
    }
  | { type: 'message'; data: LocalMessage }
  | { type: 'session'; data: LocalSession }
  | { type: 'run_started'; data: Record<string, never> }
  | {
      type: 'run_finished'
      data: { outcome: 'done' | 'failed' | 'stopped' | 'silent' }
    }
  | { type: 'progress'; data: LocalProgress }
  | { type: 'status'; data: { text: string } }
  | { type: 'error'; data: { code: string; message: string } }
export type LocalEvent = LocalEventData & {
  version: 1
  id: string
  time: string
  projectId?: string
  sessionId?: string
  runId?: string
}

/** Host validation failures use the same safe codes as the Local HTTP protocol. */
export class LocalError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'not_found' | 'unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'LocalError'
  }
}

/** In-process Local project API over the same store and channel runtime as HTTP. */
export interface LocalHost extends ChannelHost {
  projects(): LocalProject[]
  openProject(input: { cwd: string; name?: string }): Promise<LocalProject>
  sessions(projectId?: string): LocalSession[]
  messages(input: {
    projectId: string
    sessionId: string
    after?: string
    limit?: number
  }): { messages: LocalMessage[]; nextCursor?: string }
  submit(message: IncomingMessage): Promise<{ sessionId: string }>
  submit(input: {
    projectId: string
    sessionId: string
    text: string
    clientMessageId?: string
  }): Promise<{ sessionId: string; messageId: string }>
  onEvent(
    listener: (event: LocalEvent) => void,
    options?: { projectId?: string },
  ): () => void
}
