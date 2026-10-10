import { Validator } from '@cfworker/json-schema'
import type { FlexibleSchema, Tool, ToolSet } from 'ai'
import { tool as AITool, asSchema } from 'ai'
import type { VelaEventListener } from '../agent/events.ts'
import { silentLogger, type VelaLogger } from '../logger.ts'
import { classifyBashCommand } from '../security/bash-classifier.ts'
import type { HookPipeline } from '../security/hooks.ts'
import {
  decidePermission,
  type PermissionDecision,
  type PermissionRules,
  type Role,
} from '../security/roles.ts'
import type {
  ExecutionMetadata,
  ResultRecord,
} from '../session/tool-history.ts'
import { StoredToolResult, ToolResultStore } from '../session/tool-results.ts'

/** Internal tool return envelope: preserve native data separately from model-facing text. */
export class ToolExecutionResult {
  constructor(
    readonly value: unknown,
    readonly text: string,
    readonly execution: ExecutionMetadata = {},
  ) {}
}

/** What a tool call ended with (`ctx.executeTool()`, like pi's `AgentToolCallOutcome`). */
export interface ToolCallOutcome {
  toolCallId: string
  toolName: string
  /** The tool's output, or the error message when `isError` */
  result: unknown
  /** Unknown or uncallable tool, invalid arguments, rejected or blocked call, thrown error, or an error result */
  isError: boolean
  /** How long the tool ran; absent when it did not run */
  durationMs?: number
}

/** Options for `ctx.executeTool()` (like pi's `ExecuteToolOptions`). */
export interface ExecuteToolOptions {
  /** Defaults to the calling tool's signal */
  signal?: AbortSignal
  /** Receives the nested tool's partial results, in addition to `tool_execution_update` events */
  onUpdate?: (partialResult: unknown) => void
}

/** Context passed to a tool's execute. */
export interface ToolContext {
  toolCallId?: string
  /** Fires when the session is interrupted (abort, close); long-running tools should honor it */
  signal?: AbortSignal
  /**
   * Reports partial output while the tool runs (like pi's `onUpdate`); each call emits a
   * `tool_execution_update` event. Calls after the tool settled are ignored.
   */
  onUpdate?: (partialResult: unknown) => void
  /**
   * Runs another tool through the same permission checks, hooks, confirmation and tool history as
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
  executionMode?: ToolExecutionMode
  /** Hints about what the tool does (MCP's tool annotations, like pi); not verified, core does not act on them */
  annotations?: ToolAnnotations
  maxResultChars?: number

  /** How the model reaches the tool (like pi). Default `direct`. See {@link ToolExposure}. */
  exposure?: ToolExposure
  /** Group the tool belongs to, for example its MCP server (like pi) */
  namespace?: ToolNamespace
  searchHint?: string // Hint shown next to the name in the deferred tool list
}

export type ToolExecutionMode = 'sequential' | 'parallel'

/**
 * How the model reaches a tool (same values and meaning as pi). "Callable" means callable from
 * other tools through `ctx.executeTool()`.
 * - `direct`: declared to the model and callable.
 * - `model-only`: declared to the model, never callable (orchestrating or interactive tools).
 * - `deferred`: named in the system prompt; declared once `tool_search` loads it; always callable.
 * - `codemode`: never declared and not listed; callable (for tools that orchestrate other tools).
 * - `hidden`: registered but unreachable.
 */
export type ToolExposure =
  | 'direct'
  | 'model-only'
  | 'codemode'
  | 'deferred'
  | 'hidden'

/** MCP-style hints about a tool (same fields as pi's `ToolAnnotations`). */
export interface ToolAnnotations {
  /** The tool does not modify its environment */
  readOnlyHint?: boolean
  /** The tool may delete or overwrite data, rather than only add to it. Meaningful when not read-only */
  destructiveHint?: boolean
  /** Repeating a call with the same arguments has no further effect. Meaningful when not read-only */
  idempotentHint?: boolean
  /** The tool reaches an open world of external entities, such as the web */
  openWorldHint?: boolean
}

/** A group of related tools, such as the tools of one MCP server (same fields as pi's `ToolNamespace`). */
export interface ToolNamespace {
  /** For example `mcp__docs` */
  name: string
  /** Short summary shown once with the group in the deferred tool list */
  description?: string
  /** Longer usage guidance, such as MCP server instructions; returned by tool_search with the group's tools */
  instructions?: string
}

const EXPOSURES: readonly ToolExposure[] = [
  'direct',
  'model-only',
  'codemode',
  'deferred',
  'hidden',
]

/** A permission check, hook or the user turned the call down; the model gets `reason` as the result. */
class ToolRejection {
  constructor(readonly reason: string) {}
}

/**
 * A tool reported an error result (e.g. bash exiting non-zero): like pi's `isError`, the model gets
 * the output as an error result.
 */
class ToolResultError extends Error {}

/** Per call: how the call was issued */
interface CallOptions {
  toolCallId?: string
  abortSignal?: AbortSignal
  /** Set for calls a tool made through ctx.executeTool() */
  parentToolCallId?: string
  onUpdate?: (partialResult: unknown) => void
}

const DEFAULT_MAX_RESULT_CHARS = 3000 // Beyond this, the full result is saved and only a preview returned

/**
 * State shared by all sessions of one Vela: tool definitions and hooks.
 * Role and permissions, tool selection, discovered deferred tools, the tool result store,
 * persistence failure state and the execution gate are per session.
 */
interface SharedToolState {
  tools: Map<string, ToolDefinition>
  hookPipeline?: HookPipeline
  logger: VelaLogger
}

/**
 * One session's tool calls: parallel calls run together; a sequential call waits for the calls
 * started before it and holds back the calls started after it (first come, first served).
 */
class ExecutionGate {
  private barrier: Promise<void> = Promise.resolve()
  private readonly running = new Set<Promise<unknown>>()

  async run<T>(mode: ToolExecutionMode, fn: () => Promise<T>): Promise<T> {
    if (mode === 'parallel') {
      await this.barrier
      const job = fn()
      this.running.add(job)
      try {
        return await job
      } finally {
        this.running.delete(job)
      }
    }
    const previous = this.barrier
    let release!: () => void
    this.barrier = new Promise((resolve) => {
      release = resolve
    })
    try {
      await previous
      await Promise.allSettled([...this.running])
      return await fn()
    } finally {
      release()
    }
  }
}

export interface ToolRegistryForkOptions {
  /** This session's event callback (e.g. security_warning for moderate-risk bash) */
  onEvent?: VelaEventListener
  /** Session id passed to hooks */
  sessionId?: string
  /** Asks the user when the decision is ask; without it, ask means deny */
  confirm?: (toolName: string, input: unknown) => Promise<boolean>
}

export class ToolRegistry {
  private readonly shared: SharedToolState
  private onEvent?: VelaEventListener
  private sessionId?: string

  constructor(
    readonly results = new ToolResultStore(),
    shared?: SharedToolState,
  ) {
    this.shared = shared ?? { tools: new Map(), logger: silentLogger }
  }

  /**
   * A registry for one session: shares tool definitions and hooks with this registry, but has its
   * own tool result store, discovered deferred tools, persistence state and execution gate.
   */
  fork(results: ToolResultStore, options: ToolRegistryForkOptions = {}) {
    const forked = new ToolRegistry(results, this.shared)
    forked.onEvent = options.onEvent
    forked.sessionId = options.sessionId
    forked.confirm = options.confirm
    return forked
  }

  setLogger(logger: VelaLogger): void {
    this.shared.logger = logger
  }

  private persistenceFailure: Error | undefined
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
    if (this.results.history.hasAttempt(toolCallId)) return
    const call = await this.results.history.begin(toolName, toolCallId, input)
    await this.results.history.append<ResultRecord>({
      type: 'tool_result',
      callId: call.callId,
      status: 'rejected',
      durationMs: 0,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  private get tools(): Map<string, ToolDefinition> {
    return this.shared.tools
  }

  private role: Role = 'owner'
  private permissions?: PermissionRules
  /** Tools selected for the session; undefined means no limit (the role still applies) */
  private selection?: ReadonlySet<string>
  private confirm?: (toolName: string, input: unknown) => Promise<boolean>

  setRole(role: Role): void {
    this.role = role
  }

  getRole(): Role {
    return this.role
  }

  /** The session's own permission rules, layered over the role's */
  setPermissions(rules: PermissionRules | undefined): void {
    this.permissions = rules
  }

  /** Only these tools are visible / callable by the model; undefined removes the limit */
  setSelection(names: Iterable<string> | undefined): void {
    this.selection = names ? new Set(names) : undefined
  }

  /** This session's permission decision for a tool; unselected tools are always deny */
  decide(toolName: string): PermissionDecision {
    if (this.selection && !this.selection.has(toolName)) return 'deny'
    return decidePermission(this.role, toolName, this.permissions)
  }

  setHookPipeline(pipeline: HookPipeline): void {
    this.shared.hookPipeline = pipeline
  }

  private discoveredTools = new Set<string>()

  private readonly gate = new ExecutionGate()

  register(...tools: ToolDefinition[]) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(
          `[Tool ToolRegistry] Tool with name "${tool.name}" is already registered.`,
        )
      }
      // Removed in favor of executionMode; ignoring it would silently change how the tool runs
      if ('isConcurrencySafe' in tool)
        throw new Error(
          `Tool "${tool.name}": isConcurrencySafe was removed. Drop isConcurrencySafe: true; replace isConcurrencySafe: false with executionMode: 'sequential'.`,
        )
      if ('isReadOnly' in tool)
        throw new Error(
          `Tool "${tool.name}": isReadOnly was removed. Use annotations: { readOnlyHint: true } (same as pi).`,
        )
      if (tool.exposure !== undefined && !EXPOSURES.includes(tool.exposure))
        throw new Error(
          `Tool "${tool.name}": exposure must be one of ${EXPOSURES.join(', ')}, got ${JSON.stringify(tool.exposure)}`,
        )
      if (
        tool.executionMode !== undefined &&
        tool.executionMode !== 'parallel' &&
        tool.executionMode !== 'sequential'
      )
        throw new Error(
          `Tool "${tool.name}": executionMode must be 'parallel' or 'sequential', got ${JSON.stringify(tool.executionMode)}`,
        )
      this.tools.set(tool.name, tool)
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  getAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values())
  }

  toAISDKFormat(): ToolSet {
    const result: Record<string, Tool> = {}
    for (const tool of this.getActiveTools()) {
      result[tool.name] = AITool({
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: (input: unknown, options) =>
          this.track(async () => {
            const output = await this.runCall(tool, input, {
              toolCallId: options?.toolCallId,
              abortSignal: options?.abortSignal,
            })
            // A rejection is a normal result the model reads (it can change its approach)
            return output instanceof ToolRejection ? output.reason : output
          }),
      })
    }
    return result
  }

  /** Permission checks, hooks, confirmation, execution, tool history and post hooks for one call. */
  private async runCall(
    tool: ToolDefinition,
    input: unknown,
    options: CallOptions,
  ): Promise<unknown> {
    const name = tool.name
    const mode = tool.executionMode ?? 'parallel'
    const signal = options.abortSignal
    // Permissions, hooks and ask run before the execution gate, so waiting on the user doesn't hold back other calls
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
    const decision = this.decide(name)
    if (decision === 'deny') {
      return await reject(
        this.selection && !this.selection.has(name)
          ? `[Rejected] ${name} is not enabled in this session`
          : `[Rejected] Role ${this.role} may not use ${name}`,
      )
    }
    const pipeline = this.shared.hookPipeline
    const hookContext = {
      sessionId: this.sessionId,
      toolCallId: options.toolCallId,
      emit: (event: Parameters<VelaEventListener>[0]) => this.onEvent?.(event),
    }
    if (pipeline) {
      const pre = await pipeline.runPre(name, input, hookContext)
      if (pre.action === 'block') {
        return await reject(
          `[Blocked by hook] ${pre.reason || 'Operation blocked'}`,
        )
      }
      if (pre.action === 'modify' && pre.modifiedInput !== undefined) {
        input = pre.modifiedInput
        try {
          input = await validateInput(tool, input)
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
      const risk = classifyBashCommand(command)
      if (risk.level === 'dangerous') {
        return await reject(
          `[Rejected] Dangerous operation detected: ${risk.reason}\nCommand: ${command}`,
        )
      }
      if (risk.level === 'moderate')
        this.onEvent?.({
          type: 'security_warning',
          toolName: name,
          reason: risk.reason ?? 'Moderate-risk command',
          command,
        })
    }
    // ask runs after hooks, on the final input, so input changed by extensions still needs approval
    if (decision === 'ask') {
      const approved = this.confirm
        ? await untilAborted(
            this.confirm(name, input).catch(() => false),
            signal,
          )
        : false
      signal?.throwIfAborted()
      if (!approved) return await reject(`[Rejected] ${name} was not approved`)
    }
    // A nested call runs inside its parent's turn at the gate: waiting there could deadlock
    const gated = <T>(fn: () => Promise<T>) =>
      options.parentToolCallId === undefined ? this.gate.run(mode, fn) : fn()
    return await gated(async () => {
      this.shared.logger.debug(`[tools] ${name} started (${mode})`)
      this.assertHealthy()
      const history = this.results.history
      const call = await history.begin(
        name,
        options.toolCallId,
        input,
        this.results.dir,
      )
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
        })
        throw error
      }
      settled = true
      // Persist native results before formatting/truncating the model response.
      const value = raw instanceof ToolExecutionResult ? raw.value : raw
      const execution =
        raw instanceof ToolExecutionResult || raw instanceof StoredToolResult
          ? (raw.execution ?? {})
          : {}
      const maxChars = tool.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS
      let stored = raw instanceof StoredToolResult ? raw : undefined
      let text: string
      try {
        text =
          raw instanceof ToolExecutionResult
            ? raw.text
            : typeof raw === 'string'
              ? raw
              : (JSON.stringify(raw, null, 2) ?? String(raw))
        // Only what the model gets decides: a string is the text itself (its JSON escaping
        // doesn't count), and a ToolExecutionResult's value is structured data for the
        // history (e.g. edit_file's diff)
        if (
          !stored &&
          (text.length > maxChars ||
            (typeof value !== 'string' &&
              !(raw instanceof ToolExecutionResult) &&
              JSON.stringify(value)?.length > maxChars))
        ) {
          stored = await this.results.save(
            typeof value === 'string'
              ? value
              : (JSON.stringify(value, null, 2) ?? String(value)),
            name,
            truncateResult(text, maxChars),
            options.toolCallId,
            call.callId,
          )
        }
        const record = await history.append<ResultRecord>({
          type: 'tool_result',
          callId: call.callId,
          status: signal?.aborted
            ? 'cancelled'
            : execution.isError
              ? 'failed'
              : 'completed',
          durationMs: performance.now() - started,
          ...execution,
          ...(stored
            ? {
                outputPath: stored.path,
                bytes: stored.bytes,
                format:
                  raw instanceof StoredToolResult || typeof value === 'string'
                    ? ('text' as const)
                    : ('json' as const),
              }
            : { output: value ?? null }),
        })
        if (stored) {
          stored.callId = call.callId
          stored.historySeq = record.seq
          stored.execution = execution
        }
      } catch (error) {
        // Do not invent a terminal result when the result could not be recorded.
        const location = stored
          ? `full output saved at: ${stored.path}`
          : `planned output path: ${call.plannedOutputPath} (may be missing or incomplete)`
        const status =
          execution.exitCode === undefined
            ? ''
            : ` exitCode=${execution.exitCode}`
        this.persistenceFailure = new Error(
          `Tool ${name} ran, but saving its result failed. The result is unconfirmed; do not rerun it automatically. callId=${call.callId}${status}; ${location}. The output location is also recorded in tool_call.plannedOutputPath; verify it is complete, and do not treat the call as successful because of it. ${error}`,
        )
        throw this.persistenceFailure
      }
      let output = stored ? stored.preview : text
      if (pipeline) {
        const post = await pipeline.runPost(name, input, output, hookContext)
        if (post.modifiedOutput !== undefined)
          output = String(post.modifiedOutput)
      }
      // Like pi: a failed command is an error result, with its output (and where the full output is) as the message
      if (execution.isError) throw new ToolResultError(output)
      return stored ? { ...stored, preview: output } : output
    })
  }

  /**
   * Whether `name` can be run through ctx.executeTool() in this session (like pi: active direct
   * tools and every codemode / deferred tool; never model-only or hidden ones).
   */
  isCallable(name: string): boolean {
    const tool = this.tools.get(name)
    if (!tool || this.decide(name) === 'deny') return false
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
      input = await validateInput(tool, args)
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
        error instanceof Error ? error.message : String(error),
        true,
        true,
      )
    }
  }

  /** Tools declared to the model: allowed, and direct / model-only, or deferred and loaded with tool_search. */
  getActiveTools() {
    return this.getAllTools().filter((tool) => {
      if (this.decide(tool.name) === 'deny') return false
      const exposure = tool.exposure ?? 'direct'
      if (exposure === 'deferred') return this.discoveredTools.has(tool.name)
      return exposure === 'direct' || exposure === 'model-only'
    })
  }

  getDeferredToolSummary(): string {
    const deferred = this.getAllTools().filter((tool) => {
      return (
        tool.exposure === 'deferred' &&
        !this.discoveredTools.has(tool.name) &&
        this.decide(tool.name) !== 'deny'
      )
    })

    if (deferred.length === 0) return ''

    const line = (t: ToolDefinition) =>
      `- ${t.name}${t.searchHint ? ` — ${t.searchHint}` : ''}`
    // Tools without a namespace first, then one group per namespace (like pi's namespace listing)
    const groups = new Map<string, ToolDefinition[]>()
    for (const tool of deferred) {
      const key = tool.namespace?.name ?? ''
      groups.set(key, [...(groups.get(key) ?? []), tool])
    }
    const lines: string[] = (groups.get('') ?? []).map(line)
    for (const [key, tools] of groups) {
      if (!key) continue
      const description = tools.find((t) => t.namespace?.description)?.namespace
        ?.description
      lines.push(`${key}${description ? ` — ${description}` : ''}:`)
      lines.push(...tools.map((t) => `  ${line(t)}`))
    }
    return [
      'The tools below are available, but before calling one you must call tool_search to get its full schema:',
      ...lines,
    ].join('\n')
  }

  searchTools(query: string): ToolDefinition[] {
    const q = query.trim()
    const results: ToolDefinition[] = []

    const names = q.includes(',')
      ? q
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean)
      : [q]

    for (const name of names) {
      const tool = this.tools.get(name)
      if (
        tool &&
        tool.name !== 'tool_search' &&
        tool.exposure !== 'hidden' &&
        tool.exposure !== 'codemode' &&
        this.decide(tool.name) !== 'deny'
      ) {
        results.push(tool)
        this.discoveredTools.add(tool.name)
      }
    }
    return results
  }

  countTokenEstimate(): { active: number; deferred: number; total: number } {
    let active = 0
    let deferred = 0

    const declared = new Set(this.getActiveTools().map((tool) => tool.name))
    for (const tool of this.tools.values()) {
      if (tool.exposure === 'hidden') continue
      const schemaSize = JSON.stringify({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }).length
      const tokens = Math.ceil(schemaSize / 4)

      if (declared.has(tool.name)) active += tokens
      else deferred += tokens
    }

    return { active, deferred, total: active + deferred }
  }

  unregister(name: string): boolean {
    this.discoveredTools.delete(name)
    return this.tools.delete(name)
  }
}

/** Validates (and parses) input against the tool's schema; throws when it does not match. */
async function validateInput(
  tool: ToolDefinition,
  input: unknown,
): Promise<unknown> {
  const schema = asSchema(tool.inputSchema)
  if (schema.validate) {
    const validated = await schema.validate(input)
    if (!validated.success) throw validated.error
    return validated.value
  }
  const validated = new Validator(await schema.jsonSchema).validate(input)
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors))
  return input
}

/** Awaits the promise; resolves false early if signal aborts (stop waiting for the user). */
function untilAborted(
  promise: Promise<boolean>,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (!signal) return promise
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const onAbort = () => resolve(false)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then((value) => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    })
  })
}

function truncateResult(text: string, maxChars: number) {
  if (text.length <= maxChars) return text

  let headSize = Math.floor(maxChars * 0.6)
  const tailSize = maxChars - headSize
  if (
    text.charCodeAt(headSize - 1) >= 0xd800 &&
    text.charCodeAt(headSize - 1) <= 0xdbff
  )
    headSize--
  let tailStart = text.length - tailSize
  if (
    text.charCodeAt(tailStart) >= 0xdc00 &&
    text.charCodeAt(tailStart) <= 0xdfff
  )
    tailStart++
  const head = text.slice(0, headSize)
  const tail = text.slice(tailStart)
  const dropped = text.length - head.length - tail.length

  return `${head}\n\n[preview: first ${head.length} and last ${tail.length} of ${text.length} UTF-16 code units; ${dropped} omitted here, full output saved]\n\n${tail}`
}
