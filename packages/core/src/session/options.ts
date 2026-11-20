import type { LanguageModel } from 'ai'
import type { ExecutionLocation } from '../execution/types.ts'
import type { InputSource } from '../extensions/events.ts'
import type { SessionUI } from '../extensions/ui.ts'
import type { ImageContent } from '../messages.ts'
import type { ThinkingLevel } from '../models/index.ts'
import type { TokenStatus, UsageTotals } from '../usage/tracker.ts'
import type { SessionScope } from './scope.ts'
/** How queued messages are taken: one at a time (default, like pi) or all at once. */
export type QueueMode = 'one-at-a-time' | 'all'

export interface PromptOptions {
  /** Inline images attached to this input; normalized after input hooks. */
  images?: ImageContent[]
  signal?: AbortSignal
  /**
   * How to handle this input while the session is running (like pi): `steer` joins the current task
   * (after this step's tools finish, before the next model request); `followUp` runs after the current
   * task ends. Required while running (throws otherwise); ignored when idle.
   */
  streamingBehavior?: 'steer' | 'followUp'
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

/** Session ids become directory names: only letters, digits, `.`, `_` and `-`, and no leading `.`. */
const SESSION_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/

/** @experimental Shared frontend contract. */
export function assertSessionId(id: string): void {
  if (!SESSION_ID.test(id))
    throw new Error(
      `Invalid session id "${id}": use only letters, digits, . _ -, do not start with ., at most 128 characters`,
    )
}

/** How `session.sendMessage()` delivers a custom message (same as pi). */
export interface SendMessageOptions {
  /** When idle: run the agent loop with the message as its input. Default false (the message is only appended) */
  triggerTurn?: boolean
  /**
   * `steer` / `followUp`: while running, queue it like steer() / followUp() (default steer).
   * `nextTurn`: hold it and add it after the user message of the next prompt.
   */
  deliverAs?: 'steer' | 'followUp' | 'nextTurn'
}

/** Options for `vela.session(id, options)`; `scope`, `channel` and `host` also bind an already-open session. */
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
  /** UI extensions use to interact with the user; without it there is no UI (confirm always returns false) */
  ui?: SessionUI
  /** Model for this session (`provider/id` or LanguageModel), default Vela's model. Also wins over the saved choice of a resumed session. */
  model?: string | LanguageModel
  /** Thinking level, default Vela's (Vela defaults to medium, like pi). Like `model`, wins over a resumed session's saved level. */
  thinkingLevel?: ThinkingLevel
  /** Automatic compaction, default Vela's (on unless createVela({ autoCompaction: false })) */
  autoCompaction?: boolean
  /** Opt into background command deadlines for an unattended run. Defaults to false. */
  unattended?: boolean
  /**
   * Where a result this session produces outside a turn goes, when a host owns a queue for it: a
   * channel supplies its topic's input queue, so a background command's exit arrives like any other
   * input. Without it the result is a message that starts a turn.
   */
  host?: {
    deliver(text: string): void | Promise<void>
    /**
     * Persist started before execution; result admission must not wait for its response turn.
     * A stopped event without a token clears all outstanding jobs for this session.
     */
    background?(
      event:
        | { type: 'started'; token: string; id: string; commandHead: string }
        | { type: 'result'; token: string; text: string }
        | { type: 'stopped'; token?: string },
    ): void | Promise<void>
  }
}

export interface SessionUsage extends TokenStatus {
  totals: UsageTotals
  contextWindow: number
  lastRecord?: import('../usage/tracker.ts').StepRecord
}
