import { platform } from 'node:os'
import type { SectionRender } from './system-prompt.ts'

export interface EnvironmentInfo {
  /** Defaults to `process.platform` */
  os?: string
  shell?: string
  /** Defaults to local calendar date `YYYY-MM-DD` (day-granularity preserves prompt cache). */
  date?: string
}

export function localDateString(now = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function environment(info: EnvironmentInfo): SectionRender {
  return () =>
    [
      `os: ${info.os ?? platform()}`,
      `shell: ${info.shell ?? 'bash'}`,
      `Current date: ${info.date ?? localDateString()}`,
    ].join('\n')
}
