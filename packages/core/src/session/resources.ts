import type { ContextFile } from '../prompt/context-files.ts'
import type { PromptTemplate } from '../prompt/templates.ts'
import type { SkillDefinition } from '../skills/loader.ts'

/** Internal snapshot for Vela's own CLI. */
export interface SessionResources {
  contextFiles: readonly ContextFile[]
  skills: readonly SkillDefinition[]
  promptTemplates: readonly PromptTemplate[]
}
