import type { ChannelSessionSnapshot } from './types.ts'

/** Local HTTP/SSE protocol v1. The token grants the daemon's configured tool authority. */
export interface LocalOptions {
  token: string
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
