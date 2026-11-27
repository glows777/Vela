import type { VelaDatabase } from '../db/index.ts'
import type {
  CredentialStore,
  OAuthRegistrationStore,
} from '../providers/auth/types.ts'
import type {
  ModelInfo,
  ModelRegistry,
  ProviderDefinition,
  ThinkingLevel,
} from '../providers/models/index.ts'
import type { ProviderConfig } from '../providers/models-config.ts'
import type { RuntimeEventBus } from '../runtime/event-bus.ts'
import type {
  BlobStore,
  ChannelBinding,
  ChannelToolSpec,
  EnvironmentRegistry,
  MemoryRegistry,
} from '../runtime/index.ts'
import type { SubscriptionManager } from '../runtime/subscriptions.ts'
import type { TimerScheduler } from '../runtime/timers.ts'
import type { VelaLimits } from '../shared/limits.ts'
import type { VelaLogger } from '../shared/logger.ts'
import type { ModelInput } from '../shared/provider-types.ts'
import type { ExecutionLocation } from './execution/types.ts'
import type { ContextFile } from './prompt/context-files.ts'
import type { DocsPaths } from './prompt/index.ts'
import type { PromptTemplate } from './prompt/templates.ts'
import type { SessionEntry, SessionSummary } from './session/entries.ts'
import type { SessionPersistence } from './session/options.ts'
import type { SkillDefinition } from './skills/loader.ts'
import type { BackgroundTask } from './tools/background.ts'
import type { ToolDefinition, ToolRegistry } from './tools/registry.ts'
import type { UsageTotals } from './usage/tracker.ts'

export interface RuntimeMcpLease {
  waitForAll: (signal?: AbortSignal) => Promise<void>
  release: () => Promise<void>
}

export interface RuntimeMcpAdapter {
  attach: (options: {
    registry: ToolRegistry
    agentDir: string
    cwd: string
    environment: string
    trusted: boolean
    env?: Record<string, string | undefined>
    waitMs?: number
    discoveredTools?: readonly string[]
    signal?: AbortSignal
  }) => Promise<RuntimeMcpLease>
  dispose?: () => Promise<void>
}

export interface RuntimeSessionOverride {
  cwd?: string
  model?: string
  thinkingLevel?: ThinkingLevel
  tools?: string[]
  noTools?: boolean
  excludeTools?: string[]
  systemPrompt?: string
  appendSystemPrompt?: string
  noContextFiles?: boolean
  loadUntrustedContextFiles?: boolean
  extensions?: string[]
  noExtensions?: boolean
  approve?: boolean
  approveLocation?: string
  env?: Record<string, string | undefined>
  recordPath?: string
}

export interface RuntimePromptPreview {
  windowTokens: number
  systemPrompt: string
  systemPromptChars: number
  toolDescriptionChars: number
  skillsChars: number
  extensionSections: Record<string, string>
  stages: Array<{ name: string; chars: number | null }>
}

export interface RuntimeSessionInspection {
  sessionId: string
  cwd: string
  name?: string
  channel?: string
  parentSession?: string
  persistence: SessionPersistence
  modelInfo?: ModelInfo
  modelError?: string
  thinkingLevel: ThinkingLevel
  availableThinkingLevels: ThinkingLevel[]
  limits: VelaLimits
  usage: {
    tokens: number
    contextWindow: number
    percent: number
    totals: UsageTotals
  }
  entries: SessionEntry[]
  branch: SessionEntry[]
  leafId: string | null
  allTools: string[]
  activeTools: string[]
  commands: Array<{
    name: string
    description?: string
    source: 'builtin' | 'extension'
    extension?: string
  }>
  extensions: Array<{
    name: string
    tools: string[]
    providers: string[]
    commands: string[]
  }>
  extensionErrors: string[]
  hooks: { pre: string[]; post: string[] }
  runningJobs: BackgroundTask[]
  isRunning: boolean
  isBashRunning: boolean
  queuedSteering: string[]
  resources: {
    trusted: boolean
    contextFiles: ContextFile[]
    skills: Array<{
      name: string
      description: string
      filePath: string
      disableModelInvocation?: boolean
    }>
    promptTemplates: Array<{
      name: string
      description: string
      argumentHint?: string
    }>
    defaultTools?: string[]
    enabledModels?: string[]
  }
  promptSnapshot?: RuntimePromptPreview
}

export interface RuntimeSpecialModelHandle {
  model: ModelInput
  addInput?: (input: string) => void
  flush?: () => Promise<void>
  setCacheEnabled?: (enabled: boolean) => void
}

export type ResolveSpecialModelFn = (options: {
  modelRef?: string
  recordPath?: string
  fallbackModel?: ModelInput
}) => Promise<RuntimeSpecialModelHandle | undefined>

export interface RuntimeReloadableConfig {
  defaultModel?: ModelInput
  defaultThinkingLevel?: ThinkingLevel
  providers?: Record<string, ProviderDefinition>
  rawConfigProviders?: Record<string, ProviderConfig>
  shellPath?: string
  limits?: Partial<VelaLimits>
  defaultTools?: readonly string[]
  extensionConfig?: Record<string, Record<string, unknown>>
  extensions?: readonly string[]
  enabledModels?: readonly string[]
  githubRepositories?: readonly string[]
  dreamEnabled?: boolean
  autoCompaction?: boolean
  offline?: boolean
}

export interface VelaAgentDriverOptions {
  db: VelaDatabase
  agentDir: string
  blobs: BlobStore
  environments: EnvironmentRegistry
  timers?: TimerScheduler
  subscriptions?: SubscriptionManager
  eventBus?: RuntimeEventBus
  wakeSession?: (sessionId: string) => void
  flushOutbox?: () => void
  isSessionBusy?: (sessionId: string) => boolean
  mcp?: RuntimeMcpAdapter
  memoryRegistry?: MemoryRegistry
  defaultModel?: ModelInput
  defaultThinkingLevel?: ThinkingLevel
  providers?: Record<string, ProviderDefinition>
  rawConfigProviders?: Record<string, ProviderConfig>
  credentials?: CredentialStore
  registrations?: OAuthRegistrationStore
  /** @internal Shared ModelRegistry (for live OAuth registrations & planLabel consistency). */
  models?: ModelRegistry
  shellPath?: string
  limits?: Partial<VelaLimits>
  tools?: ToolDefinition[]
  defaultTools?: readonly string[]
  extensionConfig?: Record<string, Record<string, unknown>>
  extensions?: readonly string[]
  enabledModels?: readonly string[]
  githubRepositories?: readonly string[]
  getChannelTools?: (
    sessionId: string,
    runId?: string,
  ) =>
    | { binding: ChannelBinding; tools: readonly ChannelToolSpec[] }
    | undefined
  getChannelTimezone?: (channel: string) => string | undefined
  hostEnv?: Record<string, string | undefined>
  docsPaths?: DocsPaths | false
  systemPrompt?: string
  appendSystemPrompt?: string
  contextFiles?: readonly ContextFile[]
  skills?: readonly SkillDefinition[]
  promptTemplates?: readonly PromptTemplate[]
  offline?: boolean
  dreamEnabled?: boolean
  autoCompaction?: boolean
  trustOverride?: (location: ExecutionLocation) => boolean | Promise<boolean>
  toolApprovalCheck?: (
    toolName: string,
    input: unknown,
    sessionId: string,
  ) =>
    | Promise<{ requireApproval?: boolean; summary?: string } | undefined>
    | { requireApproval?: boolean; summary?: string }
    | undefined
  resolveSpecialModel?: ResolveSpecialModelFn
  spillRoot?: string
  onBeforeExtensionImport?: () => Promise<void> | void
  logger?: VelaLogger
}

export interface ActiveRunMeta {
  runId: string
  projectId: string | null
  replyToMessageId?: string
  handoffDepth?: number
  channelTarget?: { channel: string; externalChatId: string; threadId?: string }
  humanProvenance?: {
    inboxEventId: string
    senderId?: string
    senderName?: string
  }
  attachments?: Array<{
    blobId: string
    name: string
    mimeType?: string
    inlineOnly?: boolean
  }>
  markSilent: () => void
}

export type RuntimeSummaryListOptions = {
  cwd?: string
  projectId?: string
  includeArchived?: boolean
  excludeChannels?: boolean
}

export type RuntimeSummary = SessionSummary
