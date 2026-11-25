import type { ThinkingLevel } from '../../providers/models/index.ts'
import type { VelaLogger } from '../../shared/logger.ts'
import type { ModelInput } from '../../shared/provider-types.ts'
import type { ExecutionLocation } from '../execution/types.ts'
import type { InputSource } from '../extensions/events.ts'
import type { ImageContent, ModelMessage } from '../messages.ts'
import type { TokenStatus, UsageTotals } from '../usage/tracker.ts'
import type { SessionContext } from './entries.ts'
import type { SessionScope } from './scope.ts'

/** How queued steer messages are taken: one at a time (default, like pi) or all at once. */
export type QueueMode = 'one-at-a-time' | 'all'

export interface PromptOptions {
  /** Inline images attached to this input; normalized after input hooks. */
  images?: ImageContent[]
  signal?: AbortSignal
  /**
   * How to handle this input while the session is running (like pi): `steer` joins the current task
   * (after the active tool step settles, before the next model request). Required while running; ignored when idle.
   */
  streamingBehavior?: 'steer'
  /** Where the input came from, passed to `input` handlers (default `sdk`) */
  source?: InputSource
}

/** Options for `session.navigateTree()` (like pi's). */
export interface NavigateTreeOptions {
  /** Summarize the branch being left; the summary is attached where the session goes */
  summarize?: boolean
  /** What the summary should prefer to keep (pi's customInstructions) */
  focus?: string
  /** Label for the target entry (or for the summary entry when summarizing) */
  label?: string
}

/** Options for `session.fork()` / `clone()`. */
export interface ForkOptions {
  /** `before` (default): the new session ends before this user message; `at`: it includes the entry */
  position?: 'before' | 'at'
  /** Id of the new session; default a new time-based id like the CLI's */
  sessionId?: string
}

/** Session ids become safe identifiers: only letters, digits, `.`, `_` and `-`, and no leading `.`. */
const SESSION_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/

/** @experimental Shared frontend contract. */
export function assertSessionId(id: string): void {
  if (!SESSION_ID.test(id))
    throw new Error(
      `Invalid session id "${id}": use only letters, digits, . _ -, do not start with ., at most 128 characters`,
    )
}

/** How `session.sendMessage()` delivers a custom message. */
export interface SendMessageOptions {
  /** When idle: run the agent loop with the message as its input. Default false (the message is only appended) */
  triggerTurn?: boolean
  /**
   * `steer`: while running, queue it like steer().
   * `nextTurn`: hold it and add it after the user message of the next prompt.
   */
  deliverAs?: 'steer' | 'nextTurn'
}

/** @internal Transitional host callback for `legacy-channels` until S4b deletes it. */
export interface SessionHost {
  deliver(text: string): void | Promise<void>
  background?(
    event:
      | { type: 'started'; token: string; id: string; commandHead: string }
      | { type: 'result'; token: string; text: string }
      | { type: 'stopped'; token?: string },
  ): void | Promise<void>
}

/** Options for `vela.session(id, options)`; `scope` and `channel` also bind an already-open session. */
export interface SessionOptions {
  /** Transient storage sharing identity; first routing binding can attach to an already-open session. */
  scope?: SessionScope
  /** Provider channel and tool eligibility, bound together with scope before hooks. */
  channel?: string
  /** Working directory for this session's tools and automatic context; relative to Vela's cwd. */
  cwd?: string
  /** Execution location for this session. */
  location?: ExecutionLocation
  /**
   * Tools for this session: plain names (or `*` patterns) enable only those; a list of only
   * `+name` / `-name` entries adjusts the default set instead (like pi).
   */
  tools?: string[]
  /** Model for this session (`provider/id` or `ModelHandle`), default Vela's model. Also wins over the saved choice of a resumed session. */
  model?: ModelInput
  /** Thinking level, default Vela's (Vela defaults to medium, like pi). Like `model`, wins over a resumed session's saved level. */
  thinkingLevel?: ThinkingLevel
  /** Automatic compaction, default Vela's (on unless createVela({ autoCompaction: false })) */
  autoCompaction?: boolean
  /** Opt into background command deadlines for an unattended run. Defaults to false. */
  unattended?: boolean
}

/** @internal Session options including the transitional `legacy-channels` host hook. */
export interface InternalSessionOptions extends SessionOptions {
  host?: SessionHost
}

export type SessionPersistence =
  | { type: 'file'; path: string }
  | { type: 'memory' }

export interface SessionUsage extends TokenStatus {
  totals: UsageTotals
  contextWindow: number
  lastRecord?: import('../usage/tracker.ts').StepRecord
}

export interface SessionState {
  messages: ModelMessage[]
  timestamps: Map<ModelMessage, number>
  summary: string
}

export interface LoadedSessionContext extends SessionContext {
  channel?: string
  location?: ExecutionLocation
  name?: string
  model?: string
  thinkingLevel?: ThinkingLevel
  discoveredTools: string[]
  latestAssistantUsage?: {
    inputTokens: number
    outputTokens: number
    trailingMessages: ModelMessage[]
  }
}

export interface SessionStoreOptions {
  uploadsDir?: string
  logger?: VelaLogger
  ephemeral?: boolean
  cwd?: string
  location?: ExecutionLocation
  onSaved?: () => void
}
