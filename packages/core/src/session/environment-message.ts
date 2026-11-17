import type { CustomMessage } from '../agent/events.ts'
import { gitBranch } from './git-branch.ts'

/**
 * Reports a checkout in the session's working tree as one custom message. The branch cannot live in the system
 * prompt: another session or a git command can check it out while this one is open, and rewriting the prompt
 * drops the cached prefix of every later request. A session that keeps its branch reports nothing, and the first
 * turn has no earlier value to compare with.
 */
export class EnvironmentChanges {
  private branch?: string | null

  /** The message to append, or undefined when the branch is unchanged. */
  update(cwd: string): CustomMessage | undefined {
    const branch = gitBranch(cwd)
    const previous = this.branch
    this.branch = branch
    if (previous === undefined || previous === branch) return undefined
    return {
      customType: 'env',
      content: branch
        ? `Git branch: ${branch}`
        : 'The working tree is no longer a git checkout.',
      display: false,
    }
  }
}
