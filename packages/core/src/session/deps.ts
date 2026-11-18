import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'
import type { VelaEvent } from '../agent/events.ts'
import type { ExecutionEnv } from '../execution/types.ts'
import type {
  BeforeAgentStartResult,
  ExtensionEventName,
  InputSource,
  ProviderStreamEvent,
  SessionBeforeTreeEventResult,
  SessionTreeEvent,
  TreePreparation,
} from '../extensions/events.ts'
import type { VelaLimits } from '../limits.ts'
import type { VelaLogger } from '../logger.ts'
import type { ImageContent, ModelMessage } from '../messages.ts'
import type { ResolvedModel, ThinkingLevel } from '../models/index.ts'
import type { SystemPromptBuilder } from '../prompt/index.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { SessionOptions } from './options.ts'
import type { SessionResources } from './resources.ts'
import type { SessionStorage } from './storage.ts'

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
  hasHandlers(event: ExtensionEventName, toolName?: string): boolean
  /** Text after the input handlers; undefined when a handler handled it */
  input(
    session: Session,
    text: string,
    source: InputSource,
    streamingBehavior?: 'steer' | 'followUp',
    images?: ImageContent[],
  ): Promise<{ text: string; images?: ImageContent[] } | undefined>
  transformContext(
    session: Session,
    messages: ModelMessage[],
    producer: string,
  ): Promise<ModelMessage[]>
  beforeProviderRequest(
    session: Session,
    params: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4CallOptions>
  afterProviderResponse(
    session: Session,
    headers: Record<string, string>,
  ): Promise<void>
  providerStreamEvent(session: Session, event: ProviderStreamEvent): void
}

/** Shared parts createVela() hands to every session. */
export interface SessionDeps<Session> {
  /** Default model */
  model: string | LanguageModel | undefined
  /** Resolves a model by name or object (including the provider registry) for a session */
  resolveModel: (
    model: string | LanguageModel | undefined,
    session: Session,
  ) => ResolvedModel
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
  /** Where session history is stored (file / memory / custom) */
  sessionStorage: SessionStorage
  /** dataDir is a temp dir that dispose() deletes (no dataDir given): tool history may be gone on resume */
  temporaryDataDir?: boolean
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
  onClose: (session: Session) => void
  onSaved: (sessionId: string) => void
  onCwdChange: (session: Session) => void
  ensureLocal: (session: Session) => Promise<ExecutionEnv>
  prepareWorkspace: (
    session: Session,
    signal?: AbortSignal,
  ) => Promise<SessionResources>
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
