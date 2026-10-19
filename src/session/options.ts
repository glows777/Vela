/** How queued messages are taken: one at a time (default, like pi) or all at once. */
export type QueueMode = 'one-at-a-time' | 'all'

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

/** Session ids become file names: only letters, digits, `.`, `_` and `-`, and no leading `.`. */
const SESSION_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/

export function assertSessionId(id: string): void {
  if (!SESSION_ID.test(id))
    throw new Error(
      `Invalid session id "${id}": use only letters, digits, . _ -, do not start with ., at most 128 characters`,
    )
}
