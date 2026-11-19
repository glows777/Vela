import type { FlexibleSchema, ToolSet } from 'ai'
import { asSchema } from 'ai'
import type { VelaEventListener } from '../agent/events.ts'
import type { ExecutionEnv } from '../execution/types.ts'
import { silentLogger, type VelaLogger } from '../logger.ts'
import {
  isToolContent,
  normalizeToolContent,
  type ToolResultOutput,
  toolContentText,
} from '../messages.ts'
import type { SessionScope } from '../session/scope.ts'
import type { CallRecord, ResultRecord } from '../session/tool-history.ts'
import { ToolResultStore } from '../session/tool-results.ts'
import type { BackgroundCommands } from './background.ts'
import { prepareCallResult } from './call-result.ts'
import { validateToolDefinition } from './definition-validation.ts'
import { ExecutionGate, NestedExecutionGate } from './execution-gate.ts'
import {
  type CallOptions,
  errorOutput,
  persistResponse,
  recordToolRejection,
  recoverToolCall,
  rejectDrainingCall,
  ToolRejection,
} from './recovery.ts'
import { countToolTokens, toAISDKTools } from './sdk-tools.ts'
import { createToolSearchDocument, rankTools } from './tool-ranker.ts'
import {
  type ExecuteToolOptions,
  type InterceptionContext,
  type ToolAnnotations,
  type ToolCallOutcome,
  type ToolExecutionMode,
  ToolExecutionResult,
  type ToolExposure,
  type ToolInterception,
  type ToolNamespace,
  type ToolRegistryForkOptions,
  ToolResultError,
} from './types.ts'
import { validateInput } from './validation.ts'
/** Context passed to a tool's execute. */
export interface ToolContext {
  /** @internal */ execution?: ExecutionEnv
  /** @internal */ background?: BackgroundCommands
  sessionId?: string
  scope?: Readonly<SessionScope>
  toolCallId?: string
  /** Fires when the session is interrupted (abort, close); long-running tools should honor it */
  signal?: AbortSignal
  /**
   * Reports partial output while the tool runs (like pi's `onUpdate`); each call emits a
   * `tool_execution_update` event. Calls after the tool settled are ignored.
   */
  onUpdate?: (partialResult: unknown) => void
  /**
   * Runs another tool through the same availability checks, hooks and tool history as
   * a model-issued call (like pi's `ctx.executeTool()`). The call gets the id `<calling id>/<n>`, its
   * `tool_execution_*` events carry `parentToolCallId`, and it does not enter the conversation.
   * Never rejects for tool failures: they come back as `isError: true`.
   */
  executeTool?: (
    name: string,
    args: unknown,
    options?: ExecuteToolOptions,
  ) => Promise<ToolCallOutcome>
  /** @internal The session's tool result store (bash writes large output to files) */
  results: ToolResultStore
  /** @internal This call's id in the tool history */
  callId?: string
  /** @internal The (session-level) registry running this call (used by tool_search) */
  registry?: ToolRegistry
}

export interface ToolDefinition {
  name: string
  description: string
  // Input types differ per tool, so the registry stores them as any
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool inputs
  inputSchema: FlexibleSchema<any>
  execute: (
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool inputs
    input: any,
    context?: ToolContext,
  ) => Promise<unknown>

  /**
   * Same as pi: "sequential" tools run one at a time with the session's other tool calls;
   * "parallel" (default) tools run concurrently. Only calls of the same session wait for each
   * other. write_file / edit_file additionally queue per file across all sessions.
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
    readonly results = new ToolResultStore(),
    shared?: SharedToolState,
    private parent?: ToolRegistry,
  ) {
    this.shared = shared ?? { tools: new Map(), logger: silentLogger }
  }

  /**
   * A registry for one session: shares tool definitions and hooks with this registry, but has its
   * own tool result store, discovered deferred tools, persistence state and execution gate.
   */
  fork(results: ToolResultStore, options: ToolRegistryForkOptions = {}) {
    const forked = new ToolRegistry(results, this.shared, this.parent)
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

  private persistenceFailure: Error | undefined
  /** `ToolExecutionResult.value`s by tool call id, until the call's `tool_execution_end` takes them */
  private readonly details = new Map<string, unknown>()
  private readonly active = new Set<Promise<unknown>>()

  private track<T>(run: () => Promise<T>): Promise<T> {
    const job = run()
    this.active.add(job)
    void job.then(
      () => this.active.delete(job),
      () => this.active.delete(job),
    )
    return job
  }

  async waitForIdle(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active])
    this.assertHealthy()
  }

  assertHealthy(): void {
    if (this.persistenceFailure) throw this.persistenceFailure
    this.results.history.assertHealthy()
  }

  async recordRejection(
    toolName: string,
    toolCallId: string,
    input: unknown,
    error: unknown,
  ): Promise<void> {
    this.assertHealthy()
    await recordToolRejection(
      this.results.history,
      toolName,
      toolCallId,
      input,
      error,
    )
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
  private readonly unavailableTools = new Set<string>()
  private readonly runtimeEnabledTools = new Set<string>()
  private channel?: string
  /** Only these tools are visible / callable by the model; undefined removes the limit */
  setSelection(names: Iterable<string> | undefined): void {
    this.selection = names ? new Set(names) : undefined
  }

  /** `+name` / `-name` changes to the default tool set for this session (like pi); a later entry wins */
  setDefaultToolModifiers(entries: readonly string[]): void {
    this.defaultToolStates = new Map(
      entries.map((entry) => [entry.slice(1), entry.startsWith('+')]),
    )
  }

  /** Binds this session to a channel; tools declared for another channel are unavailable */
  setChannel(name: string): void {
    this.channel = name
  }

  /** Whether tool selection and channel eligibility make a tool available in this session. */
  private isAvailable(toolName: string): boolean {
    const tool = this.tools.get(toolName)
    if (!tool || this.unavailableTools.has(toolName)) return false
    if (
      tool.channel === true
        ? !this.channel
        : tool.channel !== undefined && tool.channel !== this.channel
    )
      return false
    if (this.selection) return this.selection.has(toolName)
    const enabled = this.defaultToolStates?.get(toolName)
    if (enabled === false) return false
    if (this.runtimeEnabledTools.has(toolName)) return true
    return enabled ?? tool.activeByDefault !== false
  }

  private get interception(): ToolInterception | undefined {
    return this.shared.interception ?? this.parent?.interception
  }

  setInterception(interception: ToolInterception): void {
    this.shared.interception = interception
  }

  discoveredTools = new Set<string>() // loaded with tool_search; a resumed session restores it from its history

  private readonly gate = new ExecutionGate()
  private readonly nestedGate = new NestedExecutionGate()

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

  toAISDKFormat(hostedTools: ToolSet = {}): ToolSet {
    return toAISDKTools(
      this.getActiveTools(),
      hostedTools,
      (tool, input, options) =>
        this.track(() => this.runCall(tool, input, options)),
    )
  }

  /** Availability checks, hooks, execution, tool history and post hooks for one call. */
  private async runCall(
    tool: ToolDefinition,
    input: unknown,
    options: CallOptions,
  ): Promise<unknown> {
    const name = tool.name
    const mode = tool.executionMode ?? 'parallel'
    const signal = options.abortSignal
    // Availability checks and hooks run before the execution gate, so waiting on the user doesn't hold back other calls
    this.assertHealthy()
    const reject = async (reason: string) => {
      await this.recordRejection(
        name,
        options.toolCallId ?? crypto.randomUUID(),
        input,
        reason,
      )
      return new ToolRejection(reason)
    }
    const rejectDraining = (call?: CallRecord) =>
      rejectDrainingCall(
        this.results.history,
        name,
        options.toolCallId,
        input,
        call,
      )
    if (this.isDraining()) return rejectDraining()
    if (tool.hostedOnly)
      return await reject(`[Rejected] ${name} is unavailable locally`)
    if (!this.isAvailable(name))
      return await reject(`[Rejected] ${name} is not enabled in this session`)
    const interception = this.interception
    const context: InterceptionContext = {
      sessionId: this.sessionId,
      toolCallId: options.toolCallId,
      ...(options.parentToolCallId === undefined
        ? {}
        : { parentToolCallId: options.parentToolCallId }),
    }
    if (interception?.before) {
      const pre = await interception.before(name, input, context)
      if (pre.block) {
        return await reject(
          `[Blocked by hook] ${pre.reason || 'Operation blocked'}`,
        )
      }
      if (pre.input !== input) {
        input = pre.input
        try {
          input = await validateInput(tool.inputSchema, input)
        } catch (error) {
          return await reject(
            `[Rejected] Input modified by hook is invalid: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
    if (name === 'bash') {
      const command = (input as { command?: unknown } | null)?.command
      if (typeof command !== 'string')
        return await reject('[Rejected] bash command must be a string')
    }
    // A nested call runs inside its parent's turn at the gate (waiting there could deadlock), so
    // nested calls have their own queue
    const gated = <T>(fn: () => Promise<T>) =>
      options.parentToolCallId === undefined
        ? this.gate.run(mode, fn)
        : this.nestedGate.run(
            mode,
            options.parentToolCallId,
            options.toolCallId,
            fn,
          )
    return await gated(async () => {
      if (this.isDraining()) return rejectDraining()
      this.shared.logger.debug(`[tools] ${name} started (${mode})`)
      this.assertHealthy()
      const history = this.results.history
      const location = context.execution && {
        environment: context.execution.id,
        cwd: context.execution.cwd,
      }
      // Recovery never silently moves a call to a different environment or replays changed input.
      if (
        options.recovery &&
        (!location ||
          JSON.stringify(location) !==
            JSON.stringify(options.recovery.location) ||
          JSON.stringify(input) !== JSON.stringify(options.recovery.input))
      )
        return new ToolRejection(
          `Tool ${name} was interrupted by a restart and may have partially run; its location or input changed, so it was not replayed`,
        )
      const call = await history.begin(name, options.toolCallId, input, {
        replay: tool.replay ?? 'unsafe',
        location,
        ...(options.recovery
          ? { interruption: (options.recovery.interruption ?? 0) + 1 }
          : {}),
      })
      if (this.isDraining()) return rejectDraining(call)
      const started = performance.now()
      let settled = false
      const onUpdate = (partialResult: unknown) => {
        if (settled || options.toolCallId === undefined) return
        this.onEvent?.({
          type: 'tool_execution_update',
          toolCallId: options.toolCallId,
          toolName: name,
          args: input,
          partialResult,
          ...(options.parentToolCallId === undefined
            ? {}
            : { parentToolCallId: options.parentToolCallId }),
        })
        options.onUpdate?.(partialResult)
      }
      let nested = 0
      const parentId = options.toolCallId ?? call.callId
      let raw: unknown
      try {
        signal?.throwIfAborted()
        raw = await tool.execute(input, {
          ...context,
          background: this.background,
          scope: this.scope?.(),
          results: this.results,
          toolCallId: options.toolCallId,
          callId: call.callId,
          signal,
          registry: this,
          onUpdate,
          executeTool: (nestedName, args, nestedOptions = {}) =>
            this.executeTool(
              `${parentId}/${++nested}`,
              parentId,
              nestedName,
              args,
              {
                ...nestedOptions,
                signal: nestedOptions.signal ?? signal,
              },
            ),
        })
      } catch (error) {
        settled = true
        await history.append<ResultRecord>({
          type: 'tool_result',
          callId: call.callId,
          status: signal?.aborted ? 'cancelled' : 'failed',
          durationMs: performance.now() - started,
          error: error instanceof Error ? error.message : String(error),
          modelOutput: errorOutput(error),
        })
        throw error
      }
      settled = true
      if (raw instanceof ToolExecutionResult && options.toolCallId)
        this.details.set(options.toolCallId, raw.value)
      const result = await prepareCallResult({
        raw,
        name,
        results: this.results,
        environment: context.execution,
        call,
        started,
        signal,
        maxResultChars: tool.maxResultChars,
        onPersistenceFailure: (error) => {
          this.persistenceFailure = error
        },
      })
      let { output } = result
      const { execution } = result
      if (execution.toolUnavailable) {
        this.unavailableTools.add(name)
        if (name === 'bash' && !this.selection) {
          for (const fallback of ['list_directory', 'grep', 'find'])
            if (this.defaultToolStates?.get(fallback) !== false)
              this.runtimeEnabledTools.add(fallback)
        }
      }
      if (interception?.after) {
        output = await interception.after(name, input, output, context)
      }
      // Normalize after all post hooks, including replacement image payloads.
      if (isToolContent(output)) output = await normalizeToolContent(output)
      await persistResponse(history, call.callId, output, execution.isError)
      // Like pi: a failed command is an error result, with its output (and where the full output is) as the message
      if (execution.isError)
        throw new ToolResultError(
          (typeof output === 'string' ? output : toolContentText(output)) ||
            'Tool reported an error',
          typeof output === 'string' ? undefined : output,
        )
      return output
    })
  }

  /** @internal Reconcile a missing transcript result before continuing. */
  recoverToolCall(
    name: string,
    id: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ToolResultOutput> {
    return recoverToolCall(
      this,
      name,
      id,
      input,
      signal,
      (tool, args, recovery) =>
        this.track(() =>
          this.runCall(tool, args, {
            toolCallId: id,
            abortSignal: signal,
            recovery,
          }),
        ),
    )
  }

  /**
   * Whether `name` can be run through ctx.executeTool() in this session (like pi: active direct
   * tools and every codemode / deferred tool; never model-only or hidden ones).
   */
  isCallable(name: string): boolean {
    const tool = this.tools.get(name)
    if (!tool || !this.isAvailable(name)) return false
    const exposure = tool.exposure ?? 'direct'
    return exposure !== 'model-only' && exposure !== 'hidden'
  }

  /** Runs a call a tool made through ctx.executeTool(); never rejects for tool failures. */
  private async executeTool(
    toolCallId: string,
    parentToolCallId: string,
    name: string,
    args: unknown,
    options: ExecuteToolOptions,
  ): Promise<ToolCallOutcome> {
    const event = { toolCallId, toolName: name, parentToolCallId }
    this.onEvent?.({ type: 'tool_execution_start', ...event, args })
    const started = performance.now()
    const finish = (result: unknown, isError: boolean, ran: boolean) => {
      const details = this.takeDetails(toolCallId)
      const outcome: ToolCallOutcome = {
        toolCallId,
        toolName: name,
        result,
        isError,
        ...(ran ? { durationMs: Math.round(performance.now() - started) } : {}),
      }
      this.onEvent?.({
        type: 'tool_execution_end',
        ...event,
        result,
        isError,
        ...(details === undefined || isError ? {} : { details }),
        ...(outcome.durationMs === undefined
          ? {}
          : { durationMs: outcome.durationMs }),
      })
      return outcome
    }
    const tool = this.tools.get(name)
    if (!tool || !this.isCallable(name)) {
      const reason = tool
        ? `[Rejected] ${name} cannot be called from a tool in this session`
        : `Tool ${name} not found`
      await this.recordRejection(name, toolCallId, args, reason)
      return finish(reason, true, false)
    }
    let input: unknown
    try {
      input = await validateInput(tool.inputSchema, args)
    } catch (error) {
      const reason = `Invalid arguments for ${name}: ${error instanceof Error ? error.message : String(error)}`
      await this.recordRejection(name, toolCallId, args, reason)
      return finish(reason, true, false)
    }
    try {
      const output = await this.track(() =>
        this.runCall(tool, input, {
          toolCallId,
          parentToolCallId,
          abortSignal: options.signal,
          onUpdate: options.onUpdate,
        }),
      )
      return output instanceof ToolRejection
        ? finish(output.reason, true, false)
        : finish(output, false, true)
    } catch (error) {
      // A failed result save stops the session, as it does for model-issued calls
      if (error === this.persistenceFailure) throw error
      return finish(
        error instanceof ToolResultError && error.content
          ? error.content
          : error instanceof Error
            ? error.message
            : String(error),
        true,
        true,
      )
    }
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
    const deferred = this.searchableTools()
    if (deferred.length === 0) return ''

    const lines: string[] = []
    const namespaces = new Map<string, ToolDefinition[]>()
    for (const tool of deferred) {
      if (!tool.namespace) {
        lines.push(
          `- ${tool.name}${tool.searchHint ? ` — ${tool.searchHint}` : ''}`,
        )
        continue
      }
      const key = tool.namespace.name
      namespaces.set(key, [...(namespaces.get(key) ?? []), tool])
    }
    for (const [key, tools] of namespaces) {
      const description = tools.find((t) => t.namespace?.description)?.namespace
        ?.description
      const count = `${tools.length} tool${tools.length === 1 ? '' : 's'}`
      lines.push(`- ${key} (${count})${description ? ` — ${description}` : ''}`)
    }
    return lines.join('\n')
  }

  /**
   * Loads deferred tools for this session (like pi's tool_search). A query of comma-separated exact
   * tool names loads those tools; any other query loads the `limit` best BM25 matches over names,
   * descriptions, parameters and namespaces.
   */
  async searchTools(query: string, limit = 8): Promise<ToolDefinition[]> {
    const loadable = this.searchableTools(true)
    const names = query
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
    // Exact names also return tools loaded earlier, so asking again is harmless
    const exact = names.map((name) => loadable.find((t) => t.name === name))
    let results: ToolDefinition[]
    if (names.length > 0 && exact.every((tool) => tool !== undefined)) {
      results = exact as ToolDefinition[]
    } else {
      const candidates = loadable.filter(
        (t) => !this.discoveredTools.has(t.name),
      )
      const documents = await Promise.all(
        candidates.map(async (tool) =>
          createToolSearchDocument({
            ...tool,
            jsonSchema: await asSchema(tool.inputSchema).jsonSchema,
          }),
        ),
      )
      results = rankTools(query, documents, limit).flatMap(
        (match) => candidates.find((t) => t.name === match.name) ?? [],
      )
    }
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
