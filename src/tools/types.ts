import type { VelaEventListener } from '../agent/events.ts'
import { type ToolContent, toolContentText } from '../messages.ts'
import type { ExecutionMetadata } from '../session/tool-history.ts'

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
  /** This session's event callback (e.g. security_warning for moderate-risk bash) */
  onEvent?: VelaEventListener
  /** Session id passed to hooks */
  sessionId?: string
  /** Asks the user when the decision is ask; without it, ask means deny */
  confirm?: (toolName: string, input: unknown) => Promise<boolean>
}
