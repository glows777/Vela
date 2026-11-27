import type { ExecutionLocation } from '../shared/execution.ts'

export type SessionKind = 'chat' | 'hub' | 'topic' | 'work'
export type SessionState = 'idle' | 'running' | 'waiting_human' | 'stopped'

export interface ProjectRecord {
  id: string
  name: string
  cwd: string | null
  dataDir: string | null
  hubSessionId: string | null
  defaultDriver: string
  defaultLocation: ExecutionLocation | null
  defaultModel: string | null
  defaultThinkingLevel: string | null
  defaultTools: string[] | null
  config: Record<string, unknown> | null
  archived: boolean
  createdAt: string
  updatedAt: string
}

export interface SessionRecord {
  id: string
  projectId: string | null
  kind: SessionKind
  driver: string
  externalSessionId: string | null
  name: string | null
  archived: boolean
  model: string | null
  thinkingLevel: string | null
  location: ExecutionLocation | null
  leafMessageId: string | null
  discoveredTools: string[]
  parentSessionId: string | null
  state: SessionState
  waitingReason: string | null
  followupStreak: number
  createdAt: string
  updatedAt: string
}
