import type { VelaDatabase } from './db/index.ts'
import type { CompactionResult } from './driver/agent/events.ts'
import type { ExecutionLocation } from './driver/execution/types.ts'
import type { ContextFile } from './driver/prompt/context-files.ts'
import type { PromptTemplate } from './driver/prompt/templates.ts'
import type {
  RuntimeSessionInspection,
  RuntimeSessionOverride,
  RuntimeSummary,
  RuntimeSummaryListOptions,
} from './driver/runtime-types.ts'
import type { SessionEntry, SessionTreeNode } from './driver/session/entries.ts'
import type {
  ForkOptions,
  NavigateTreeOptions,
} from './driver/session/options.ts'
import type { SkillDefinition } from './driver/skills/loader.ts'
import type {
  BackgroundSnapshot,
  BackgroundTask,
} from './driver/tools/background.ts'
import type { ToolDefinition } from './driver/tools/registry.ts'
import type { BashResult } from './driver/tools/shell.ts'
import type {
  AuthInteraction,
  CredentialStore,
  LoginOptions,
  LogoutOptions,
  LogoutResult,
} from './providers/auth/types.ts'
import type {
  LoginProvider,
  ModelInfo,
  ProviderDefinition,
  ThinkingLevel,
} from './providers/models/index.ts'
import type {
  AgentDriver,
  ApprovalRecord,
  BlobDirection,
  BlobRecord,
  ChannelAdapter,
  ChannelBinding,
  ChannelChatInfo,
  ChannelHostSubmitInput,
  ChannelHostSubmitResult,
  ChannelStatusInfo,
  CreateProjectInput,
  CreateSessionInput,
  EnvironmentRegistry,
  ProjectRecord,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeMessagePage,
  RuntimeWebhookEvent,
  SessionRecord,
  SessionStatusInfo,
  StreamDeltaEvent,
  StreamDeltaListener,
  SubscriptionRecord,
  TimerKind,
  TimerRecord,
  TimerTarget,
  UpdateProjectInput,
  UpsertChannelBindingInput,
} from './runtime/index.ts'
import type { VelaLimits } from './shared/limits.ts'
import type { VelaLogger } from './shared/logger.ts'
import type { OAuthRegistration } from './shared/oauth-registration.ts'
import type { ModelInput } from './shared/provider-types.ts'
import type { RoutineSchedule } from './shared/routine-time.ts'

export type { RuntimeEvent, RuntimeSessionInspection }

export interface RuntimePromptInput {
  text: string
  dedupeKey?: string
  source?: 'user' | 'handoff' | 'session'
  wake?: boolean
  passive?: boolean
  attachments?: Array<{
    blobId: string
    name: string
    mimeType?: string
    inlineOnly?: boolean
  }>
  metadata?: Record<string, unknown>
}

export interface RuntimeRecoverySummary {
  interruptedJobs: string[]
  recoveredRuns: string[]
  requeuedInboxRuns: string[]
  wokenSessions: string[]
}

/**
 * Transport-compatible Runtime SDK contract implemented by in-process `createRuntime()`
 * and S4a's daemon IPC `connectRuntime()`. Domain records, cursors, events, and results
 * are plain JSON-serializable objects; `blobs.read`/`storeInbound` pass `Uint8Array`
 * buffers (base64 on the wire), `events.subscribe`/`subscribeDeltas` return sync
 * unsubscribe functions over the daemon stream, and `logout` supports `AbortSignal`.
 */
export interface VelaRuntime {
  readonly agentDir: string
  ready(): Promise<void>
  extensionErrors(): Promise<string[]>
  reloadConfig(): Promise<void>
  readonly projects: {
    list(options?: { includeArchived?: boolean }): Promise<ProjectRecord[]>
    get(id: string): Promise<ProjectRecord | undefined>
    getByCwd(cwd: string): Promise<ProjectRecord | undefined>
    create(input: CreateProjectInput): Promise<ProjectRecord>
    update(id: string, patch: UpdateProjectInput): Promise<ProjectRecord>
    remove(id: string, options?: { deleteSessions?: boolean }): Promise<boolean>
  }
  readonly trust: {
    check(location: string | ExecutionLocation): Promise<boolean | undefined>
    approve(
      location: string | ExecutionLocation,
      trusted: boolean,
    ): Promise<void>
  }
  readonly oauthRegistrations: {
    get(provider: string): Promise<OAuthRegistration | undefined>
    set(provider: string, registration: OAuthRegistration): Promise<void>
    delete(provider: string): Promise<boolean>
  }
  readonly sessions: {
    list(options?: {
      projectId?: string | null
      includeArchived?: boolean
    }): Promise<SessionRecord[]>
    listSummaries(
      options?: RuntimeSummaryListOptions,
    ): Promise<RuntimeSummary[]>
    get(id: string): Promise<SessionRecord | undefined>
    create(input?: CreateSessionInput): Promise<SessionRecord>
    rename(id: string, name: string | null): Promise<SessionRecord>
    delete(id: string): Promise<boolean>
    reset(id: string): Promise<SessionRecord>
    status(id: string): Promise<SessionStatusInfo>
    messages(input: {
      sessionId: string
      cursor?: string
      limit?: number
    }): Promise<RuntimeMessagePage>
    configure(
      sessionId: string,
      override: RuntimeSessionOverride,
    ): Promise<void>
    setModel(sessionId: string, modelRef: string): Promise<ModelInfo>
    setThinkingLevel(
      sessionId: string,
      level: ThinkingLevel,
    ): Promise<ThinkingLevel>
    compact(
      sessionId: string,
      instructions?: string,
    ): Promise<CompactionResult | undefined>
    tree(sessionId: string): Promise<{
      tree: SessionTreeNode[]
      branch: SessionEntry[]
      entries: SessionEntry[]
      leafId: string | null
    }>
    navigateTree(
      sessionId: string,
      targetId: string,
      options?: NavigateTreeOptions,
    ): Promise<{
      editorText?: string
      cancelled: boolean
      branch: SessionEntry[]
    }>
    setLabel(
      sessionId: string,
      entryId: string,
      label: string | undefined,
    ): Promise<void>
    fork(
      sessionId: string,
      entryId: string,
      options?: ForkOptions,
    ): Promise<{
      cancelled: boolean
      sessionId?: string
      selectedText?: string
    }>
    clone(
      sessionId: string,
      options?: Omit<ForkOptions, 'position'>,
    ): Promise<{
      cancelled: boolean
      sessionId?: string
      selectedText?: string
    }>
    inspect(
      sessionId: string,
      options?: { previewPrompt?: boolean; includeEntries?: boolean },
    ): Promise<RuntimeSessionInspection>
    execBash(
      sessionId: string,
      command: string,
      options?: { excludeFromContext?: boolean; id?: string },
    ): Promise<BashResult>
    abortBash(sessionId: string): Promise<void>
    runCommand(sessionId: string, input: string): Promise<{ handled: boolean }>
    clearQueue(sessionId: string): Promise<{ steering: string[] }>
    export(
      sessionId: string,
      format: 'jsonl' | 'html',
      outputPath?: string,
      baseCwd?: string,
    ): Promise<string>
  }
  prompt(
    sessionId: string,
    input: RuntimePromptInput,
  ): Promise<{ eventId: string; inserted: boolean }>
  steer(sessionId: string, text: string): Promise<void>
  stop(sessionId: string, reason?: string): Promise<boolean>
  waitForIdle(sessionId?: string): Promise<void>
  readonly jobs: {
    list(sessionId?: string): Promise<BackgroundTask[]>
    stop(sessionId: string, jobId: string): Promise<BackgroundSnapshot>
    promoteForeground(sessionId: string, toolCallId?: string): Promise<string[]>
  }
  readonly approvals: {
    list(sessionId?: string): Promise<ApprovalRecord[]>
    resolve(input: {
      approvalId: string
      decision: 'approved' | 'denied' | 'cancelled'
      reason?: string
      decidedBy?: string
    }): Promise<{ approval: ApprovalRecord; shouldWake: boolean }>
  }
  readonly timers: {
    list(filter?: {
      projectId?: string
      sessionId?: string
      kind?: TimerKind
      enabledOnly?: boolean
    }): Promise<TimerRecord[]>
    createRoutine(input: {
      id?: string
      projectId?: string | null
      sessionId?: string | null
      channel?: string | null
      target?: TimerTarget
      creatorId?: string | null
      creatorName?: string | null
      message: string
      schedule: RoutineSchedule
      timezone?: string
      nowMs?: number
    }): Promise<TimerRecord>
    createFollowup(input: {
      id?: string
      sessionId: string
      projectId?: string | null
      channel?: string | null
      target?: TimerTarget
      message: string
      fireAt: string
      creatorId?: string | null
      creatorName?: string | null
    }): Promise<TimerRecord>
    update(
      id: string,
      patch: {
        message?: string
        schedule?: RoutineSchedule
        timezone?: string
        enabled?: boolean
        nowMs?: number
      },
    ): Promise<TimerRecord | undefined>
    delete(id: string): Promise<boolean>
  }
  readonly subscriptions: {
    list(filter?: {
      sessionId?: string
      projectId?: string
      source?: string
    }): Promise<SubscriptionRecord[]>
    create(input: {
      id?: string
      source: string
      eventKey: string
      projectId?: string | null
      sessionId: string
      creatorId?: string | null
      creatorName?: string | null
    }): Promise<SubscriptionRecord>
    remove(id: string): Promise<boolean>
  }
  readonly bindings: {
    list(filter?: {
      channel?: string
      projectId?: string
      enabledOnly?: boolean
    }): Promise<ChannelBinding[]>
    get(id: string): Promise<ChannelBinding | undefined>
    upsert(input: UpsertChannelBindingInput): Promise<ChannelBinding>
    setEnabled(
      id: string,
      enabled: boolean,
    ): Promise<ChannelBinding | undefined>
    remove(id: string): Promise<boolean>
  }
  readonly channels: {
    list(): Promise<ChannelStatusInfo[]>
    setEnabled(name: string, enabled: boolean): Promise<ChannelStatusInfo>
    chats(channel: string): Promise<ChannelChatInfo[]>
    submit(
      channel: string,
      input: ChannelHostSubmitInput,
    ): Promise<ChannelHostSubmitResult>
  }
  readonly blobs: {
    get(id: string): Promise<BlobRecord | undefined>
    list(sessionId: string, direction?: BlobDirection): Promise<BlobRecord[]>
    read(id: string): Promise<Uint8Array>
    storeInbound(input: {
      id?: string
      sessionId?: string | null
      projectId?: string | null
      messageId?: string | null
      filename: string
      mimeType?: string
      bytes?: Uint8Array
      hostPath?: string
    }): Promise<BlobRecord>
  }
  readonly events: {
    list(options?: {
      sessionId?: string
      projectId?: string
      afterSeq?: number
      limit?: number
    }): Promise<RuntimeEvent[]>
    bufferedDeltas(sessionId: string): Promise<StreamDeltaEvent[]>
    subscribe(listener: RuntimeEventListener): () => void
    subscribeDeltas(listener: StreamDeltaListener): () => void
  }
  models(options?: {
    all?: boolean
    channel?: string
    env?: Record<string, string | undefined>
  }): Promise<ModelInfo[]>
  loginProviders(): Promise<LoginProvider[]>
  login(
    provider: string,
    method: 'oauth' | 'api_key',
    interaction: AuthInteraction,
    options?: LoginOptions,
  ): Promise<void>
  logout(provider: string, options?: LogoutOptions): Promise<LogoutResult>
  recover(): Promise<RuntimeRecoverySummary>
  dispose(): Promise<void>
}

/**
 * In-process Runtime handle returned by `createRuntime()`, extending `VelaRuntime`
 * with host-local registration hooks that are not sent across daemon IPC.
 */
export interface LocalVelaRuntime extends VelaRuntime {
  registerChannel(adapter: ChannelAdapter): Promise<void>
  unregisterChannel(name: string): Promise<void>
  registerDriver(driver: AgentDriver): void
  ingestWebhookEvent(
    event: RuntimeWebhookEvent,
    defaultTarget?: { channel: string; chatId: string },
  ): Promise<{
    matchedSessionIds: string[]
    defaultTargetSessionId?: string
    enqueuedCount: number
  }>
  getWebhookConfig(): {
    webhooks?: Record<string, unknown>
    eventDefaultTarget?: { channel: string; chatId: string }
  }
  getLarkConfig(): {
    lark?: Record<string, unknown>
    larkError?: string
    disabledByExtension?: boolean
  }
  /** @internal Syncs active `hub`/`topic` session defaults after daemon project config changes. */
  reconcileProjectSessions?(
    projectId: string,
    fields?: {
      location?: boolean
      model?: boolean
      thinkingLevel?: boolean
      topicModel?: boolean
      topicThinkingLevel?: boolean
    },
  ): Promise<void>
}

export interface CreateRuntimeOptions {
  /** Root agent directory (`~/.vela`), owning `<agentDir>/vela.db` and `<agentDir>/blobs/`. */
  agentDir?: string
  /** Use an in-memory `:memory:` SQLite database and isolate from on-disk `config.json`, `auth.json`, and user MCP. */
  ephemeral?: boolean
  /** Use an in-memory `:memory:` SQLite database while keeping owner config, credentials, and memory at `agentDir`. */
  ephemeralSessions?: boolean
  /** @internal Pre-opened SQLite database for tests or daemon hosting. */
  db?: VelaDatabase
  /** Environment variables used for `$VAR` provider interpolation and default `VELA_DIR`. */
  hostEnv?: Record<string, string | undefined>
  providers?: Record<string, ProviderDefinition>
  credentials?: CredentialStore
  defaultModel?: ModelInput
  defaultThinkingLevel?: ThinkingLevel
  limits?: Partial<VelaLimits>
  tools?: ToolDefinition[]
  extensionConfig?: Record<string, Record<string, unknown>>
  contextFiles?: readonly ContextFile[]
  skills?: readonly SkillDefinition[]
  promptTemplates?: readonly PromptTemplate[]
  /** Enable per-project MCP pooling (lazy-loaded on first turn). Default `true`. */
  mcp?: boolean
  offline?: boolean
  dreamEnabled?: boolean
  /** Owner Docker environment definitions or a pre-constructed `EnvironmentRegistry`. Defaults to `<agentDir>/config.json` unless `ephemeral`. */
  environments?: Record<string, unknown> | EnvironmentRegistry
  drivers?: AgentDriver[]
  trustOverride?: (location: ExecutionLocation) => boolean | Promise<boolean>
  toolApprovalCheck?: (
    toolName: string,
    input: unknown,
    sessionId: string,
  ) =>
    | Promise<{ requireApproval?: boolean; summary?: string } | undefined>
    | { requireApproval?: boolean; summary?: string }
    | undefined
  /** @internal Daemon hook invoked after `config.json` reloads. */
  onConfigReloaded?: (config: {
    webhooks?: Record<string, unknown>
    eventDefaultTarget?: { channel: string; chatId: string }
  }) => Promise<void> | void
  /** @internal Daemon hook invoked after `config.json` reloads Lark settings. */
  onLarkConfigReloaded?: (config: {
    lark?: Record<string, unknown>
    larkError?: string
    disabledByExtension?: boolean
  }) => Promise<void> | void
  /** @internal Daemon hook invoked when `channels.setEnabled()` toggles a channel. */
  onChannelEnabledChange?: (
    name: string,
    enabled: boolean,
  ) => Promise<void> | void
  /** @internal Daemon hook returning known configured channel names/errors. */
  getKnownChannelInfo?: () => {
    names?: readonly string[]
    errors?: ReadonlyMap<string, string>
  }
  logger?: VelaLogger
}
