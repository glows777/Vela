import type { ProviderToolSpec } from '../../providers/index.ts'
import { silentLogger, type VelaLogger } from '../../shared/logger.ts'
import { type ToolInputSchema, toJsonSchema } from '../../shared/tool-schema.ts'
import { getRetiredToolError } from '../../shared/tool-selection.ts'
import type { VelaEvent, VelaEventListener } from '../agent/events.ts'
import type { ExecutionEnv } from '../execution/types.ts'
import type { SessionScope } from '../session/scope.ts'
import type { BackgroundCommands } from './background.ts'
import { validateToolDefinition } from './definition-validation.ts'
import { ActiveCalls, ExecutionGate } from './execution-gate.ts'
import { countToolTokens, toProviderTools } from './sdk-tools.ts'
import {
  createToolSearchDocument,
  formatDeferredToolSummary,
  rankTools,
} from './tool-ranker.ts'
import type {
  ToolAnnotations,
  ToolExecutionMode,
  ToolExposure,
  ToolInterception,
  ToolNamespace,
  ToolRegistryForkOptions,
} from './types.ts'

/** Context passed to a tool's execute. */
export interface ToolContext {
  /** @internal */ execution?: ExecutionEnv
  /** @internal */ background?: BackgroundCommands
  sessionId?: string
  scope?: Readonly<SessionScope>
  toolCallId?: string
  /** Resolve the session's execution environment on demand (file, search, bash tools only). */
  requireEnv?: (signal?: AbortSignal) => Promise<ExecutionEnv>
  /** Fires when the session is interrupted (abort, close); long-running tools should honor it */
  signal?: AbortSignal
  /** Reports partial output while the tool runs (`tool_execution_update`); calls after settle are ignored. */
  onUpdate?: (partialResult: unknown) => void
  /** @internal Directory where large outputs may spill to temp files. */
  spillDir?: string
  /** @internal The (session-level) registry running this call (used by tool_search) */
  registry?: ToolRegistry
}

export interface ToolDefinition {
  name: string
  description: string
  // Input types differ per tool, so the registry stores them as any
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool inputs
  inputSchema: ToolInputSchema<any>
  execute: (
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool inputs
    input: any,
    context?: ToolContext,
  ) => Promise<unknown>

  /**
   * Same as pi: "sequential" tools run one at a time with the session's other tool calls;
   * "parallel" (default) tools run concurrently. Only calls of the same session wait for each
   * other. write / edit additionally queue per file across all sessions.
   */
  /** Whether an interrupted call may be replayed after a restart. Default unsafe. */
  replay?: 'safe' | 'unsafe'
  executionMode?: ToolExecutionMode
  /** Hints about what the tool does (MCP's tool annotations, like pi); not verified, core does not act on them */
  annotations?: ToolAnnotations
  maxResultChars?: number

  /** How the model reaches the tool (like pi). Default `direct`. See {@link ToolExposure}. */
  exposure?: ToolExposure
  /** Group the tool belongs to, for example its MCP server (like pi) */
  namespace?: ToolNamespace
  searchHint?: string // Hint shown next to the name in the deferred tool list
  /** One line for the prompt's `<tools>` while the tool is active; no line without one (like pi) */
  promptSnippet?: string
  /** Bullets for `<rules>` while the tool is active (like pi) */
  promptGuidelines?: readonly string[]
  /** An exact channel name, or true for any channel-bound session; undefined means every session. */
  channel?: string | true
  /** Whether the tool is on without being named (like pi's `defaultActive`); default true. `false` keeps it registered but off until a session names it */
  activeByDefault?: false
  /** Only available when the model supplies a provider-hosted equivalent. */
  hostedOnly?: true
}

/**
 * State shared by all sessions of one Vela: tool definitions and hooks.
 * Tool selection, discovered deferred tools, the tool result store,
 * persistence failure state and the execution gate are per session.
 */
interface SharedToolState {
  tools: Map<string, ToolDefinition>
  interception?: ToolInterception
  logger: VelaLogger
}

export class ToolRegistry {
  /** @internal Session-owned admission gate; never shared with other registry forks. */
  isDraining: () => boolean = () => false
  private shared: SharedToolState
  /** @internal The `background` extension's job table; `bash` reaches it through `ToolContext`. */
  background?: BackgroundCommands
  private onEvent?: VelaEventListener
  private sessionId?: string
  private scope?: () => Readonly<SessionScope> | undefined

  constructor(
    readonly spillDir?: string,
    shared?: SharedToolState,
    private parent?: ToolRegistry,
  ) {
    this.shared = shared ?? { tools: new Map(), logger: silentLogger }
  }

  /**
   * A registry for one session: shares tool definitions and hooks with this registry, but has its
   * own spill directory, discovered deferred tools, and execution gate.
   */
  fork(spillDir?: string, options: ToolRegistryForkOptions = {}) {
    const forked = new ToolRegistry(spillDir, this.shared, this.parent)
    forked.onEvent = options.onEvent
    forked.sessionId = options.sessionId
    forked.scope = options.scope
    return forked
  }

  /** @internal Bind a prepared project without replacing this session's execution state. */
  bindScope(registry: ToolRegistry): void {
    this.shared = registry.shared
    this.parent = registry.parent
  }

  setLogger(logger: VelaLogger): void {
    this.shared.logger = logger
  }

  get logger(): VelaLogger {
    return this.shared.logger
  }

  /** `ToolExecutionResult.value`s by tool call id, until the call's `tool_execution_end` takes them */
  private readonly details = new Map<string, unknown>()
  private readonly active = new ActiveCalls()

  /** @internal An idle move also excludes calls issued directly through the registry. */
  get hasActiveCalls(): boolean {
    return this.active.running
  }

  async waitForIdle(): Promise<void> {
    await this.active.waitForIdle()
  }

  trackCall<T>(fn: () => Promise<T>): Promise<T> {
    return this.active.track(fn)
  }

  runInGate<T>(mode: ToolExecutionMode, fn: () => Promise<T>): Promise<T> {
    return this.gate.run(mode, fn)
  }

  emitEvent(event: VelaEvent): void {
    this.onEvent?.(event)
  }

  setDetails(toolCallId: string, value: unknown): void {
    this.details.set(toolCallId, value)
  }

  currentSessionId(): string | undefined {
    return this.sessionId
  }

  currentScope(): Readonly<SessionScope> | undefined {
    return this.scope?.()
  }

  private get tools(): Map<string, ToolDefinition> {
    if (!this.parent) return this.shared.tools
    const tools = new Map(this.parent.tools)
    for (const [name, tool] of this.shared.tools) {
      if (tools.has(name))
        throw new Error(`Tool "${name}" is registered in both host and project`)
      tools.set(name, tool)
    }
    return tools
  }

  /** Tools selected for the session; undefined means no limit */
  private selection?: ReadonlySet<string>
  private defaultToolStates?: ReadonlyMap<string, boolean> // +name / -name overrides from --tools or defaultTools
  private channel?: string
  /** Only these tools are visible / callable by the model; undefined removes the limit */
  setSelection(names: Iterable<string> | undefined): void {
    const list = names ? [...names] : undefined
    if (list) {
      const retired = getRetiredToolError(list)
      if (retired) throw new Error(`Invalid tools selection: ${retired}`)
    }
    this.selection = list ? new Set(list) : undefined
  }

  /** `+name` / `-name` changes to the default tool set for this session (like pi); a later entry wins */
  setDefaultToolModifiers(entries: readonly string[]): void {
    const retired = getRetiredToolError(entries)
    if (retired) throw new Error(`Invalid tools selection: ${retired}`)
    this.defaultToolStates = new Map(
      entries.map((entry) => [entry.slice(1), entry.startsWith('+')]),
    )
  }

  /** Binds this session to a channel; tools declared for another channel are unavailable */
  setChannel(name: string): void {
    this.channel = name
  }

  /** Whether tool selection and channel eligibility make a tool available in this session. */
  isAvailable(toolName: string): boolean {
    const tool = this.tools.get(toolName)
    if (!tool) return false
    if (
      tool.channel === true
        ? !this.channel
        : tool.channel !== undefined && tool.channel !== this.channel
    )
      return false
    if (this.selection) return this.selection.has(toolName)
    const enabled = this.defaultToolStates?.get(toolName)
    if (enabled === false) return false
    return enabled ?? tool.activeByDefault !== false
  }

  getInterception(): ToolInterception | undefined {
    return this.shared.interception ?? this.parent?.interception
  }

  private get interception(): ToolInterception | undefined {
    return this.getInterception()
  }

  setInterception(interception: ToolInterception): void {
    this.shared.interception = interception
  }

  discoveredTools = new Set<string>() // loaded with tool_search; a resumed session restores it from its history

  private readonly gate = new ExecutionGate()

  register(...tools: ToolDefinition[]) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(
          `[Tool ToolRegistry] Tool with name "${tool.name}" is already registered.`,
        )
      }
      validateToolDefinition(tool)
      this.shared.tools.set(tool.name, tool)
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  getAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values())
  }

  toProviderTools(): ProviderToolSpec[] {
    return toProviderTools(this.getActiveTools())
  }

  /** Display data (`ToolExecutionResult.value`) of a finished call, for its `tool_execution_end`; removes it. */
  takeDetails(toolCallId: string): unknown {
    const details = this.details.get(toolCallId)
    this.details.delete(toolCallId)
    return details
  }

  /** Tools declared to the model: allowed, and direct / model-only, or deferred and loaded with tool_search. */
  getActiveTools() {
    return this.getAllTools().filter((tool) => {
      if (!this.isAvailable(tool.name)) return false
      const exposure = tool.exposure ?? 'direct'
      if (exposure === 'deferred') return this.discoveredTools.has(tool.name)
      return exposure === 'direct' || exposure === 'model-only'
    })
  }

  /** Tools tool_search can load in this session: allowed deferred tools (not yet loaded, unless `loaded`). */
  private searchableTools(loaded = false): ToolDefinition[] {
    return this.getAllTools().filter(
      (tool) =>
        tool.exposure === 'deferred' &&
        tool.name !== 'tool_search' &&
        (loaded || !this.discoveredTools.has(tool.name)) &&
        this.isAvailable(tool.name),
    )
  }

  /** The `<deferred_tools>` lines. Like pi, a namespace (an MCP server) gets one line, not its tools. */
  getDeferredToolSummary(): string {
    return formatDeferredToolSummary(this.searchableTools(true))
  }

  /** Loads deferred tools (comma-separated exact names, or top `limit` BM25 matches). */
  async searchTools(query: string, limit = 8): Promise<ToolDefinition[]> {
    const loadable = this.searchableTools(true)
    const names = query
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
    const exact = names.map((name) => loadable.find((t) => t.name === name))
    const results =
      names.length > 0 && exact.every((tool) => tool !== undefined)
        ? (exact as ToolDefinition[])
        : rankTools(
            query,
            await Promise.all(
              loadable.map(async (tool) =>
                createToolSearchDocument({
                  ...tool,
                  jsonSchema: await toJsonSchema(tool.inputSchema),
                }),
              ),
            ),
            limit,
          ).flatMap((m) => loadable.find((t) => t.name === m.name) ?? [])
    for (const tool of results) this.discoveredTools.add(tool.name)
    return results
  }

  countTokenEstimate(): { active: number; deferred: number; total: number } {
    return countToolTokens(
      this.getAllTools(),
      new Set(this.getActiveTools().map((tool) => tool.name)),
    )
  }

  unregister(name: string): boolean {
    this.discoveredTools.delete(name)
    return this.shared.tools.delete(name)
  }
}
