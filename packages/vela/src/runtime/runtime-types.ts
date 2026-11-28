import type { VelaDatabase } from '../db/index.ts'
import type { VelaLogger } from '../shared/logger.ts'
import type { AgentDriver } from './driver.ts'
import type { EnvironmentRegistry } from './environments.ts'

export interface VelaRuntimeEngineOptions {
  db: VelaDatabase
  agentDir: string
  environments?: EnvironmentRegistry
  drivers?: AgentDriver[]
  ignoredChannels?: readonly string[]
  onRestartSession?: (sessionId: string) => Promise<void> | void
  trySteerInboxEvent?: (
    sessionId: string,
    inboxEventId: string,
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
  ) => Promise<boolean> | boolean
  logger?: VelaLogger
}

export interface ActiveWorker {
  runId: string
  ownerToken: string
  controller: AbortController
  promise: Promise<void>
  suppressedInterruptedIds?: Set<string>
}
