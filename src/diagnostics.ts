import type { ContextFile } from './prompt/context-files.ts'
import { type Vela, velaInternals } from './vela-core.ts'
import type { VelaSession } from './vela-session.ts'

/** @experimental Read-only frontend data; diagnostic presentation may evolve. */
export interface VelaInspection {
  contextFiles: readonly Readonly<ContextFile>[]
  skills: readonly {
    name: string
    description: string
    disableModelInvocation?: boolean
  }[]
  promptTemplates: readonly {
    name: string
    description: string
    argumentHint?: string
  }[]
  tools: readonly { name: string; description: string }[]
  hooks: { pre: readonly string[]; post: readonly string[] }
}

/** @experimental A prompt preview, never mutable assembly objects. */
export interface SessionInspection {
  windowTokens: number
  systemPromptChars: number
  toolDescriptionChars: number
  skillsChars: number
  extensionSections: Readonly<Record<string, string>>
  stages: readonly { name: string; chars: number | null }[]
}

/** @experimental Inspect loaded resources without running extension hooks. */
export function inspectVela(vela: Vela): VelaInspection {
  const internal = velaInternals(vela)
  const hooks = internal.hooks.list()
  return {
    contextFiles: internal.loadedContextFiles.map((file) => ({ ...file })),
    skills: internal.skillLoader
      .list()
      .map(({ name, description, disableModelInvocation }) => ({
        name,
        description,
        disableModelInvocation,
      })),
    promptTemplates: internal.promptTemplates.map(
      ({ name, description, argumentHint }) => ({
        name,
        description,
        argumentHint,
      }),
    ),
    tools: internal.registry
      .getAllTools()
      .map(({ name, description }) => ({ name, description })),
    hooks: { pre: [...hooks.pre], post: [...hooks.post] },
  }
}

/** @experimental Extension preview is explicit: ordinary inspection does not run before_agent_start. */
export async function inspectSession(
  vela: Vela,
  session: VelaSession,
  options: { previewExtensions?: boolean } = {},
): Promise<SessionInspection> {
  const internal = velaInternals(vela)
  const sections = options.previewExtensions
    ? await session.previewSections()
    : { ...session.promptContext().extensionSections }
  const active = session.registry.getActiveTools()
  const skills =
    internal.skillLoader.buildPromptSection(active.map((tool) => tool.name)) ??
    ''
  return {
    windowTokens: session.usage.contextWindow,
    systemPromptChars: session.buildSystem(sections).length,
    toolDescriptionChars: active.reduce(
      (size, tool) =>
        size +
        tool.name.length +
        tool.description.length +
        JSON.stringify(tool.inputSchema || {}).length,
      0,
    ),
    skillsChars: skills.length,
    extensionSections: { ...sections },
    stages: internal.builder.status({
      ...session.promptContext(sections),
      toolCount: internal.registry.getAllTools().length,
    }),
  }
}
