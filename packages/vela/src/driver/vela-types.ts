import type { VelaDatabase } from '../db/index.ts'
import type {
  AuthInteraction,
  CredentialStore,
  LoginOptions,
  LogoutOptions,
  LogoutResult,
} from '../providers/auth/types.ts'
import type {
  LoginProvider,
  ModelInfo,
  ProviderDefinition,
  ThinkingLevel,
} from '../providers/models/index.ts'
import type { VelaLimits } from '../shared/limits.ts'
import type { VelaLogger } from '../shared/logger.ts'
import type { ModelInput } from '../shared/provider-types.ts'
import type { VelaSessionEventListener } from './agent/events.ts'
import type { ConfigResourceSplit } from './config/runtime-resources.ts'
import type { ExecutionEnv, ExecutionLocation } from './execution/types.ts'
import type { ExtensionRunner, LoadedExtension } from './extensions/runner.ts'
import type { VelaExtension } from './extensions/types.ts'
import type { ContextFile } from './prompt/context-files.ts'
import type { DocsPaths, SystemPromptBuilder } from './prompt/index.ts'
import type { PromptTemplate } from './prompt/templates.ts'
import type { SessionSummary } from './session/entries.ts'
import type { SessionOptions } from './session/options.ts'
import type { SessionSearchHit } from './session/search.ts'
import type { SkillLoader } from './skills/loader.ts'
import type { BinaryResolver } from './tools/binaries.ts'
import type { ToolRegistry } from './tools/registry.ts'
import type { VelaSession } from './vela-session.ts'

export interface VelaOptions {
  /** @internal Host/workspace resource split from the frontend configuration. */
  sessionResources?: ConfigResourceSplit
  /** @internal Synchronous OS metadata lookup by environment name. */
  envOs?: (environment: string) => string | undefined
  /** @internal Synchronous network mode lookup by environment name. */
  envNetworkMode?: (environment: string) => 'on' | 'off' | 'restricted'
  /** Resolve the execution environment for a session tool call. */
  env?: (target: {
    sessionId: string
    location: ExecutionLocation
  }) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>
  /** Observes real nonempty storage writes, including writes outside prompts. */
  onSessionSaved?: (sessionId: string) => void
  /** Stops external ingress after factories settle and before sessions close. */
  beforeDispose?: () => void | Promise<void>
  /**
   * Default model: an AI SDK LanguageModel (tests pass faux), or `provider/id` (looked up in `providers`
   * and providers registered by extensions). Core never reads environment variables: the CLI uses the
   * providers from loadConfig(). Without it, a session must call setModel() (or resume a session with a
   * saved model) before it can prompt.
   */
  model?: ModelInput
  /** Model providers (built-in anthropic / openai / openrouter / deepseek + models.json from loadConfig(), or your own) */
  providers?: Record<string, ProviderDefinition>
  /**
   * Credentials stored by `/login` and `vela.login()`, read by providers per request. Default: in memory only.
   * The CLI passes `loadConfig().credentials` (`~/.vela/auth.json`).
   */
  credentials?: CredentialStore
  /** Thinking level for new sessions, default medium (like pi) */
  thinkingLevel?: ThinkingLevel
  /**
   * Automatic compaction for new sessions, default on (like pi's `compaction.enabled`). Off: the context is never
   * compacted on its own (no threshold summary, no compact-and-retry on overflow); `compact()` still works.
   */
  autoCompaction?: boolean
  /** Working directory for file, search and bash tools and skills; default process.cwd(). */
  cwd?: string
  /**
   * @internal Root user agent directory (`~/.vela`) owning the shared `<agentDir>/vela.db` and `<agentDir>/blobs/`.
   */
  agentDir?: string
  /**
   * Project data directory (memory/, tool-results/, container workspace/); relative paths resolve against cwd.
   * Without it nothing persists: sessions stay in memory, long tool output etc. goes to a temp dir deleted by dispose().
   * The CLI uses `~/.vela/projects/<encoded cwd>` (see loadConfig).
   */
  dataDir?: string
  /**
   * @internal Pre-opened SQLite database to share across sessions (defaults to `<dataDir>/vela.db` or `:memory:` when ephemeral).
   */
  db?: VelaDatabase
  /** Force in-memory SQLite session persistence even when `dataDir` is set (`--no-session`). */
  ephemeralSessions?: boolean
  /**
   * Skill directories or `.md` files (Agent Skills format, see docs/skills.md), in priority order: the first skill
   * with a name wins. Default `<cwd>/.vela/skills`, `<cwd>/.skills`. The model sees each skill's name, description
   * and path and reads the file itself; `/skill:<name> args` sends a skill explicitly.
   */
  skillDirs?: string[]
  /** Prompt template directories or `.md` files (`/<name> args` expands the template); first name wins. Default `<cwd>/.vela/prompts` */
  promptTemplateDirs?: string[]
  /**
   * AGENTS.md / CLAUDE.md files put into the system prompt. Default: found from cwd
   * up to the filesystem root like pi (`loadContextFiles({ cwd })`; the CLI also passes `~/.vela/AGENTS.md`). `false` loads none.
   */
  contextFiles?: false | ContextFile[]
  /** Text appended to the system prompt (pi's `--append-system-prompt`) */
  appendSystemPrompt?: string
  /**
   * Replaces the default system prompt (pi's `--system-prompt` / `SYSTEM.md`): this text becomes the intro and
   * the tool list, rules and docs sections are left out. Addendum, project context, skills, cwd, env and
   * extension sections stay. `--append-system-prompt` still applies on top.
   */
  systemPrompt?: string
  /**
   * Where Vela's own README, docs and examples live, for the `<docs>` section: the CLI and the SDK umbrella point
   * at their package. Only folders that exist are used; without a docs folder the section stays off. `false` for none.
   */
  docs?: DocsPaths | false
  /** Config section per extension; each extension reads its own section from `vela.config` (by extension name) */
  extensionConfig?: Record<string, Record<string, unknown>>
  /** Retry, compaction threshold and other limits; missing fields use defaults (see src/limits.ts). */
  limits?: Partial<VelaLimits>
  /**
   * Where the grep / find tools keep ripgrep and fd (the CLI uses `~/.vela/bin`). Checked before
   * PATH; a missing program is downloaded here (same as pi). Without it only PATH is searched.
   */
  binDir?: string
  /** Shell the bash tool and `session.executeBash()` run commands with. Default: bash on PATH, or bash.exe on Windows. */
  shellPath?: string
  /** Don't download ripgrep / fd into `binDir` (the CLI sets this from `VELA_OFFLINE=1`). */
  offline?: boolean
  /** Diagnostic output that is not an event (extensions, hooks, bad session file lines, ...); silent by default. */
  logger?: VelaLogger
  /**
   * Extensions to load, run in order (like pi; the SDK includes no built-in extensions by default).
   * Memory, knowledge base and web tools are extensions too: `[memory(), rag({ embedder }), web({ tavilyKey })]`.
   * Extension config is passed as factory arguments, e.g. `lark({ appId, appSecret })`.
   */
  extensions?: VelaExtension[]
}

/** Which saved sessions a listing or search covers. */
export interface SavedSessionOptions {
  /** Also cover sessions archived with `setSessionArchived()` (default false) */
  includeArchived?: boolean
}

/** Return value of createVela(). */
export interface Vela {
  readonly cwd: string
  readonly dataDir: string
  /** Default model (a name is resolved on first access; throws if none is given or it cannot be resolved) */
  readonly model: ModelInput
  readonly limits: VelaLimits
  /**
   * Models of the providers that have a credential (`provider/id`, context window, price, ...), used by `/model`
   * and `--list-models`; `{ all: true }` includes providers without one.
   */
  models(options?: { all?: boolean; channel?: string }): ModelInfo[]
  /** Update a configured provider for subsequent model selections. */
  configureProvider(name: string, provider: ProviderDefinition): void
  /** Set defaults for subsequently created sessions, without changing open sessions. */
  setDefaults(model: ModelInput, thinkingLevel: ThinkingLevel): void
  /** Providers `/login` can sign in to, with their current credential source */
  loginProviders(): LoginProvider[]
  /**
   * Signs in to a provider and stores the credential (pi's `/login`): `oauth` runs the provider's sign-in,
   * `api_key` asks for a key through `interaction`. Sessions use the new credential from their next request.
   */
  login(
    provider: string,
    method: 'oauth' | 'api_key',
    interaction: AuthInteraction,
    options?: LoginOptions,
  ): Promise<void>
  /**
   * Removes a provider's stored credential (`/logout`), returning `{ removed, forgotten?, notice? }`.
   * A provider whose sign-in can revoke its session does so first, and `notice` reports when revocation
   * could not be confirmed. Pass `{ forget: true }` to also drop any retained client registration.
   */
  logout(provider: string, options?: LogoutOptions): Promise<LogoutResult>
  /**
   * Opens a session (or returns it if already open). Options apply on first open, except a first channel
   * routing binding may attach to an existing object. Call `await session.resume()` to restore history.
   */
  session(id?: string, options?: SessionOptions): VelaSession
  /** Currently open sessions */
  sessions(): VelaSession[]
  /**
   * Saved sessions, newest first, from `vela.db`.
   * Sessions archived with `setSessionArchived()` are left out unless `includeArchived` is set.
   */
  listSessions(options?: SavedSessionOptions): Promise<SessionSummary[]>
  /**
   * Archives or unarchives a saved session, without opening it.
   * Resolves when the entry is saved; rejects when nothing is saved under `id`.
   */
  setSessionArchived(id: string, archived: boolean): Promise<void>
  /**
   * Searches the text of saved sessions' user and assistant messages (not tool output, `!` commands, summaries
   * or custom messages); newest first, one hit per session with a short match around the query.
   */
  searchSessions(
    query: string,
    options?: SavedSessionOptions,
  ): Promise<SessionSearchHit[]>
  /** Subscribes to events from all sessions; returns an unsubscribe function */
  subscribe(listener: VelaSessionEventListener): () => void
  /** Waits for all extensions (including async factories) to load; rejects if loading fails */
  ready(): Promise<void>
  /** Loaded extensions and the tools, commands and channels they registered */
  extensions(sessionId?: string): LoadedExtension[]
  /** Commands registered by extensions */
  commands(
    sessionId?: string,
  ): { name: string; description?: string; extension: string }[]
  /**
   * Attempts all cleanup, then rejects with AggregateError if any step failed.
   * Concurrent/repeated calls share the same result; failed cleanup is not retried.
   */
  dispose(): Promise<void>
}

/** Internals used by the CLI and tests; not part of the public API. */
export interface VelaInternals {
  logger: VelaLogger
  registry: ToolRegistry
  runner: ExtensionRunner
  builder: SystemPromptBuilder
  skillLoader: SkillLoader
  promptTemplates: PromptTemplate[]
  loadedContextFiles: readonly ContextFile[]
  /** Finds (or downloads) rg / fd, shared with the grep and find tools */
  resolveBinary: BinaryResolver
}

const internals = new WeakMap<Vela, VelaInternals>()

/** @internal Attaches internals to a Vela host instance. */
export function setVelaInternals(vela: Vela, value: VelaInternals): void {
  internals.set(vela, value)
}

/** @internal Gets Vela's internals (for CLI commands and tests). */
export function velaInternals(vela: Vela): VelaInternals {
  const found = internals.get(vela)
  if (!found) throw new Error('Not a Vela created by createVela()')
  return found
}
