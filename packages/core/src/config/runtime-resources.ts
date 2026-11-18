import type { ContextFile } from '../prompt/context-files.ts'

/** Internal source split for resources assembled by loadConfig and consumed by createVela. */
export interface ConfigResourceSplit {
  userContextFiles: ContextFile[]
  hostSkillDirs: string[]
  hostPromptDirs: string[]
  workspaceSkills: 'all' | 'none' | 'home'
  workspaceTemplates: boolean
}
