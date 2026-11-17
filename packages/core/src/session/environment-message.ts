import type { CustomMessage } from '../agent/events.ts'
import type { ModelMessage } from '../messages.ts'
import { gitBranch } from './git-branch.ts'
import type { MessageQueue } from './message-queue.ts'

/**
 * Reports a checkout in the session's working tree as one custom message. The branch cannot live in the system
 * prompt: another session or a git command can check it out while this one is open, and rewriting the prompt
 * drops the cached prefix of every later request. A session that keeps its branch reports nothing, and the first
 * turn has no earlier value to compare with.
 */
export class EnvironmentChanges {
  private branch?: string | null

  /** `queue`: the session's messages, whose custom metadata says which branch a restored history last reported. */
  constructor(private readonly queue?: MessageQueue) {}

  /** The message to append, or undefined when the branch is unchanged. `history` seeds the baseline after a load. */
  update(
    cwd: string,
    history: readonly ModelMessage[] = [],
  ): CustomMessage | undefined {
    const branch = gitBranch(cwd)
    if (this.branch === undefined) {
      const reported = this.reportedFrom(history)
      this.branch = reported === undefined ? branch : reported
    }
    const previous = this.branch
    this.branch = branch
    if (previous === branch) return undefined
    return {
      customType: 'env',
      content: branch
        ? `Git branch: ${branch}`
        : 'The working tree is no longer a git checkout.',
      display: false,
      // Round-trips through the session file, so a resume can compare against what the model was told
      details: { branch },
    }
  }

  /**
   * The branch a restored history last reported, so a checkout made while the session was closed still reaches the
   * model. Undefined when it reported none: the baseline then starts from the current checkout, and a session that
   * was never told a branch announces nothing.
   */
  private reportedFrom(
    history: readonly ModelMessage[],
  ): string | null | undefined {
    for (let index = history.length - 1; index >= 0; index--) {
      const info = this.queue?.customMessages.get(history[index]!)
      if (info?.customType !== 'env') continue
      return reportedBranch(info.details)
    }
    return undefined
  }
}

/**
 * The branch a restored session last reported, from a `custom_message` entry's `details`. Undefined when the
 * history has none (a session that never announced a branch, or one written before this field existed).
 */
export function reportedBranch(details: unknown): string | null | undefined {
  if (!details || typeof details !== 'object' || !('branch' in details))
    return undefined
  const branch = (details as { branch?: unknown }).branch
  return typeof branch === 'string' || branch === null ? branch : undefined
}
