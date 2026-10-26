import { readFileSync, statSync } from 'node:fs'
import { platform } from 'node:os'
import { join, resolve } from 'node:path'
import type { PipeFn } from './pipeline.ts'

export interface EnvironmentInfo {
  /** Session working directory; the git branch is read from here */
  cwd: string
  /** `YYYY-MM-DD`; defaults to today in the local calendar */
  date?: string
  /** IANA zone name; defaults to the system zone */
  timezone?: string
  /** Defaults to `process.platform` */
  os?: string
  /** Shell for the bash tool; defaults to `bash` on PATH */
  shell?: string
  /** Defaults to reading `.git/HEAD` under `cwd`; null leaves the line out */
  branch?: string | null
}

/**
 * `<env>`: stable facts about where the session runs. The date, never the time of day, so the cached prompt
 * prefix only changes when the date does.
 */
export function environment(info: EnvironmentInfo): PipeFn {
  return () => {
    const lines = [
      `date: ${info.date ?? localDate()}`,
      `timezone: ${info.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}`,
      `os: ${info.os ?? platform()}`,
      `shell: ${info.shell ?? 'bash'}`,
    ]
    const branch = info.branch === undefined ? gitBranch(info.cwd) : info.branch
    if (branch) lines.push(`git branch: ${branch}`)
    return `<env>\n${lines.join('\n')}\n</env>`
  }
}

/** `en-CA` renders YYYY-MM-DD in the local calendar; `toISOString()` is UTC and can be a day off */
function localDate(): string {
  return new Date().toLocaleDateString('en-CA')
}

/** The branch (or short hash) of `cwd`'s checkout, read from `.git/HEAD` without a subprocess. */
function gitBranch(cwd: string): string | null {
  try {
    let gitDir = join(cwd, '.git')
    // A worktree or submodule has a `.git` file pointing at the real directory
    if (statSync(gitDir).isFile()) {
      const pointer = /^gitdir: (.+)$/m.exec(readFileSync(gitDir, 'utf8'))
      const dir = pointer?.[1]
      if (!dir) return null
      gitDir = resolve(cwd, dir.trim())
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    const ref = 'ref: refs/heads/'
    if (head.startsWith(ref)) return head.slice(ref.length)
    return /^[0-9a-f]{7,40}$/.test(head) ? head.slice(0, 7) : null
  } catch {
    // Not a checkout (or unreadable): the block has no branch line
    return null
  }
}
