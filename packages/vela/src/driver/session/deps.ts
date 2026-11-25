import type { VelaDatabase } from '../../db/index.ts'
import type {
  ResolvedModel,
  ThinkingLevel,
} from '../../providers/models/index.ts'
import type { VelaLimits } from '../../shared/limits.ts'
import type { VelaLogger } from '../../shared/logger.ts'
import type {
  ModelInput,
  ProviderRequestParams,
} from '../../shared/provider-types.ts'
import type { VelaEvent } from '../agent/events.ts'
import type { ExecutionEnv, ExecutionLocation } from '../execution/types.ts'
import type {
  BeforeAgentStartResult,
  ExtensionEventName,
  InputSource,
  ProviderStreamEvent,
  SessionBeforeTreeEventResult,
  SessionTreeEvent,
  TreePreparation,
} from '../extensions/events.ts'
import type { ImageContent, ModelMessage } from '../messages.ts'
import type { SystemPromptBuilder } from '../prompt/index.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { SessionOptions } from './options.ts'
import type { PreparedSessionResources } from './resources.ts'

/** What the extension runtime does during the session lifecycle (provided by createVela). */
interface SessionExtensionHooks<Session> {
  /** All extensions have loaded */
  ready: Promise<void>
  sessionStart(session: Session): Promise<void>
  sessionShutdown(session: Session): Promise<void>
  beforeAgentStart(
    session: Session,
    prompt: string,
  ): Promise<BeforeAgentStartResult>
  runCommand(
    session: Session,
    text: string,
    signal: AbortSignal,
  ): Promise<boolean>
  beforeTree(
    session: Session,
    preparation: TreePreparation,
    signal: AbortSignal,
  ): Promise<SessionBeforeTreeEventResult>
  tree(session: Session, event: SessionTreeEvent): Promise<void>
  /** True when an extension cancels the fork */
  beforeFork(
    session: Session,
    entryId: string,
    position: 'before' | 'at',
  ): Promise<boolean>
  hasHandlers(
    event: ExtensionEventName,
    toolName?: string,
    options?: { scopedOnly?: boolean },
  ): boolean
  /** Text after the input handlers; undefined when a handler handled it */
  input(
    session: Session,
    text: string,
    source: InputSource,
    streamingBehavior?: 'steer',
    images?: ImageContent[],
  ): Promise<{ text: string; images?: ImageContent[] } | undefined>
  transformContext(
    session: Session,
    messages: ModelMessage[],
    producer: string,
  ): Promise<ModelMessage[]>
  beforeProviderRequest(
    session: Session,
    params: ProviderRequestParams,
  ): Promise<ProviderRequestParams>
  afterProviderResponse(
    session: Session,
    headers: Record<string, string>,
  ): Promise<void>
  providerStreamEvent(session: Session, event: ProviderStreamEvent): void
}

/** Shared parts createVela() hands to every session. */
export interface SessionDeps<Session> {
  /** Only configuration-backed frontends need project defaults before command dispatch. */
  prepareCommands?: boolean
  /** Default model */
  model: ModelInput | undefined
  /** Resolves a model by name or object (including the provider registry) for a session */
  resolveModel: (
    model: ModelInput | undefined,
    session: Session,
  ) => ResolvedModel
  /** Live subscription plan label for a provider/channel pair (reflects mid-session login/logout). */
  planLabel?: (provider: string, channel?: string) => string | undefined
  /** Effective credential mode for a provider/channel pair (`oauth` vs `api_key`). */
  authMode?: (
    provider: string,
    channel?: string,
  ) => 'oauth' | 'api_key' | undefined
  thinkingLevel: ThinkingLevel
  /** Automatic compaction for new sessions */
  autoCompaction: boolean
  /** Opens a new session in the same Vela (fork / clone); throws if the id is already open */
  openSession: (id: string, options: SessionOptions) => Session
  /** Explicitly given limits; the rest are derived from the model's context window */
  limitOverrides: Partial<VelaLimits>
  logger: VelaLogger
  dataDir: string
  /** Working directory, recorded in new session files; `executeBash()` runs commands here */
  cwd?: string
  /** Shell for `executeBash()` (settings `shellPath`); default bash on PATH, or bash.exe on Windows */
  shellPath?: string
  /** Shared Vela SQLite database */
  db: VelaDatabase
  /** When true, sessions run against an in-memory DB without disk persistence */
  ephemeral?: boolean
  /** dataDir is a temp dir that dispose() deletes */
  temporaryDataDir?: boolean
  /** Per-session root for uploaded attachments */
  uploadsRoot: (sessionId: string) => string
  /** Per-session directory for spilled large tool outputs */
  spillRoot: (sessionId: string) => string
  /** Vela-level tool registry; each session forks its own from it */
  registry: ToolRegistry
  builder: SystemPromptBuilder
  /** Expands `/skill:<name>` and prompt templates in session input (src/prompt/templates.ts) */
  expandInput: (
    text: string,
    session: Session,
    signal?: AbortSignal,
  ) => Promise<string>
  extensions: SessionExtensionHooks<Session>
  /** Session events also go to Vela's subscribers */
  forward: (event: VelaEvent, sessionId: string) => void
  onClose: (session: Session) => void | Promise<void>
  onSaved: (sessionId: string) => void
  hasResolver: boolean
  discardWorkspace: (
    session: Session,
    location: ExecutionLocation,
  ) => Promise<void>
  bindWorkspace: (session: Session) => void
  resolveExecution: (
    session: Session,
    location?: ExecutionLocation,
  ) => Promise<ExecutionEnv>
  prepareWorkspace: (
    session: Session,
    signal?: AbortSignal,
    location?: ExecutionLocation,
  ) => Promise<PreparedSessionResources>
}

/** What `fork()` / `clone()` returns. */
export interface ForkResult<Session> {
  /** True when an extension cancelled it (no session was created) */
  cancelled: boolean
  /** The new session, open in the same Vela (the original stays open) */
  session?: Session
  /** Text of the user message forked from (`before`), for the input box */
  selectedText?: string
}
