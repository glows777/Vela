import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ContextFile } from '../prompt/context-files.ts'
import type { ExtensionEntry } from './extension-discovery.ts'
import type { VelaSettings } from './settings-values.ts'

/** Internal source split for resources assembled by loadConfig and consumed by createVela. */
export interface ConfigResourceSplit<Factory = unknown> {
  hostExtensions?: ExtensionEntry[]
  extensionBuiltins?: { names: string[]; defaultOff: string[] }
  projectExtensions?: (input: {
    cwd: string
    environmentId: string
    trusted: boolean
    settings: VelaSettings
    projectSettings: VelaSettings
    entries: ExtensionEntry[]
  }) => Promise<{
    key: string
    extensionConfig: Record<string, Record<string, unknown>>
    load(): Promise<Factory[]>
  }>

  useBuiltinLocal?: boolean
  fallbackModel?: string
  fallbackShellPath?: string
  previousDataDir?: string
  userSettings?: VelaSettings
  env?: Record<string, string | undefined>
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
