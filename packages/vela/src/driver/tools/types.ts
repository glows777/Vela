import type { VelaEventListener } from '../agent/events.ts'
import type { ExecutionEnv } from '../execution/types.ts'
import { type ToolContent, toolContentText } from '../messages.ts'
import type { SessionScope } from '../session/scope.ts'

/** Execution metadata attached to a tool result (recorded on `vela_tool_calls` and `tool` messages). */
export interface ExecutionMetadata {
  exitCode?: number
  isError?: boolean
  timedOut?: boolean
  signal?: string | null
  error?: string
  backgroundTaskId?: string
  backgroundedByUser?: boolean
}

/** Oversized tool output spilled to a file inside the execution environment. */
export class SpilledToolOutput {
  constructor(
    readonly path: string,
    readonly bytes: number,
    readonly preview: string,
    readonly execution: ExecutionMetadata = {},
  ) {}
}

/** Identity of a call passed to the assembly's awaited interception callbacks and to tools. */
export interface InterceptionContext {
  /** @internal */ execution?: ExecutionEnv
  sessionId?: string
  toolCallId?: string
}

interface ToolBeforeResult {
  input: unknown
  block?: boolean
  reason?: string
  approval?: { summary: string }
}

export interface ToolInterception {
  resolveEnv?: (
    sessionId: string | undefined,
    signal?: AbortSignal,
  ) => Promise<ExecutionEnv>
  before?: (
    name: string,
    input: unknown,
    context: InterceptionContext,
  ) => ToolBeforeResult | Promise<ToolBeforeResult>
  after?: (
    name: string,
    input: unknown,
    output: string | ToolContent,
    context: InterceptionContext,
    isError?: boolean,
  ) => string | ToolContent | Promise<string | ToolContent>
}

/** A tool's native details plus model-facing text or canonical text/image content. */
export class ToolExecutionResult {
  readonly text: string
  readonly content?: ToolContent
  constructor(
    readonly value: unknown,
    content: string | ToolContent,
    readonly execution: ExecutionMetadata = {},
  ) {
    this.text = typeof content === 'string' ? content : toolContentText(content)
    if (typeof content !== 'string') this.content = content
  }
}

export type ToolExecutionMode = 'sequential' | 'parallel'

/**
 * How the model reaches a tool (same values and meaning as pi):
 * - `direct`: declared to the model.
 * - `model-only`: declared to the model.
 * - `deferred`: named in the system prompt; declared once `tool_search` loads it.
 * - `hidden`: registered but unreachable.
 */
export type ToolExposure = 'direct' | 'model-only' | 'deferred' | 'hidden'

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

/**
 * A tool reported an error result (e.g. bash exiting non-zero): like pi's `isError`, the model gets
 * the output as an error result.
 */
export class ToolResultError extends Error {
  constructor(
    message: string,
    readonly content?: ToolContent,
  ) {
    super(message)
  }
}

export interface ToolRegistryForkOptions {
  scope?: () => Readonly<SessionScope> | undefined
  /** This session's event callback */
  onEvent?: VelaEventListener
  /** Session id passed to hooks */
  sessionId?: string
}
