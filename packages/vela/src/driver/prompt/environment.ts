import { platform } from 'node:os'
import type { SectionRender } from './system-prompt.ts'

export interface EnvironmentInfo {
  /** Defaults to `process.platform` */
  os?: string
  shell?: string
}

export function environment(info: EnvironmentInfo): SectionRender {
  return () =>
    [`os: ${info.os ?? platform()}`, `shell: ${info.shell ?? 'bash'}`].join(
      '\n',
    )
}
