import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ContextFile } from '../prompt/context-files.ts'

/** Internal source split for resources assembled by loadConfig and consumed by createVela. */
export interface ConfigResourceSplit {
  userContextFiles: ContextFile[]
  hostSkillDirs: string[]
  hostPromptDirs: string[]
  agentDir: string
  cwd: string
  workspaceSkills: 'all' | 'none' | 'home'
  workspaceModeAt?: (cwd: string) => ConfigResourceSplit['workspaceSkills']
}

export type SystemFile = 'SYSTEM.md' | 'APPEND_SYSTEM.md'

export function readLocalSystemFile(
  dirs: readonly string[],
  name: SystemFile,
): string | undefined {
  for (const dir of dirs) {
    const path = join(dir, name)
    if (existsSync(path)) return readFileSync(path, 'utf8')
  }
}
