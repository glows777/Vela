import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * The branch (or short hash) of `cwd`'s checkout, read from `.git/HEAD` without a subprocess; null outside
 * a checkout. The result changes whenever something else checks out a branch in the same working tree, so it
 * travels as a message rather than living in the system prompt (see `VelaSession`'s environment message).
 */
export function gitBranch(cwd: string): string | null {
  try {
    const gitDir = findGitDir(cwd)
    if (!gitDir) return null
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    const ref = 'ref: refs/heads/'
    if (head.startsWith(ref)) return head.slice(ref.length)
    return /^[0-9a-f]{7,40}$/.test(head) ? head.slice(0, 7) : null
  } catch {
    // Not a checkout (or unreadable)
    return null
  }
}

/**
 * The `.git` directory of the nearest checkout at or above `cwd`, so a session opened in a repository
 * subdirectory still knows its branch. A worktree or submodule has a `.git` file pointing at the real directory.
 */
function findGitDir(cwd: string): string | null {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const git = join(dir, '.git')
    try {
      if (statSync(git).isFile()) {
        const pointer = /^gitdir: (.+)$/m.exec(readFileSync(git, 'utf8'))
        const target = pointer?.[1]
        return target ? resolve(dir, target.trim()) : null
      }
      return git
    } catch {
      // Nothing here; a checkout may still be an ancestor
    }
    if (dirname(dir) === dir) return null
  }
}
