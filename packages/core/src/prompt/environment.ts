import { platform } from 'node:os'
import type { SectionRender } from './system-prompt.ts'

export interface EnvironmentInfo {
  /** Session working directory */
  cwd: string
  /** `YYYY-MM-DD`; defaults to today in the local calendar */
  date?: string
  /** IANA zone name; defaults to the system zone */
  timezone?: string
  /** Defaults to `process.platform` */
  os?: string
  /** Shell for the bash tool; defaults to `bash` on PATH */
  shell?: string
}

/**
 * `<env>`: facts that stay true for the session, so the cached prompt prefix only changes when the date does.
 * The git branch is not one of them: anything that checks out a branch in the working tree during the session
 * would rewrite the whole prefix. It travels as a message instead (see `VelaSession`'s environment message).
 */
export function environment(info: EnvironmentInfo): SectionRender {
  return () =>
    [
      `date: ${info.date ?? localDate()}`,
      `timezone: ${info.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}`,
      `os: ${info.os ?? platform()}`,
      `shell: ${info.shell ?? 'bash'}`,
    ].join('\n')
}

/** `en-CA` renders YYYY-MM-DD in the local calendar; `toISOString()` is UTC and can be a day off */
function localDate(): string {
  return new Date().toLocaleDateString('en-CA')
}
