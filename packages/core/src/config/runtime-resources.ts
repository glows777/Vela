import type { ContextFile } from '../prompt/context-files.ts'

/** Internal source split for resources assembled by loadConfig and consumed by createVela. */
export interface ConfigResourceSplit {
  userContextFiles: ContextFile[]
  hostSkillDirs: string[]
  hostPromptDirs: string[]
  workspaceSkills: boolean
  workspaceTemplates: boolean
}
const splits = new WeakMap<object, ConfigResourceSplit>()
export function rememberResourceSplit(
  keys: object[],
  split: ConfigResourceSplit,
): void {
  for (const key of keys) splits.set(key, split)
}
export function configResourceSplit(
  ...keys: unknown[]
): ConfigResourceSplit | undefined {
  for (const key of keys) {
    if (key && typeof key === 'object') {
      const split = splits.get(key)
      if (split) return split
    }
  }
}
