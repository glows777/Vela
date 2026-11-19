import type { ConfigResourceSplit } from '../config/runtime-resources.ts'
import type { VelaSettings } from '../config/settings-values.ts'
import type { ExecutionEnv, ExecutionLocation } from '../execution/types.ts'
import type { VelaLogger } from '../logger.ts'
import { loadEnvironmentContextFiles } from '../prompt/environment-context-files.ts'
import { loadEnvironmentTemplates } from '../prompt/environment-templates.ts'
import { loadEnvironmentSkills } from '../skills/environment-skills.ts'
import { type SessionResources, sessionSystemFile } from './resources.ts'

export function workspaceKey(id: string, location: ExecutionLocation) {
  return JSON.stringify([id, location.environment, location.cwd])
}

export async function loadWorkspaceInventory(
  env: ExecutionEnv,
  signal: AbortSignal,
  settings: VelaSettings,
  workspaceMode: ConfigResourceSplit['workspaceSkills'] | undefined,
  {
    host,
    pinned,
    contextEnabled,
    explicitSkills,
    explicitTemplates,
    split,
    logger,
  }: {
    host: SessionResources
    pinned: boolean
    contextEnabled: boolean
    explicitSkills: boolean
    explicitTemplates: boolean
    split?: ConfigResourceSplit
    logger: VelaLogger
  },
): Promise<SessionResources> {
  const local = env.id === 'node:local'
  const location = env.cwd
  const workspace =
    !contextEnabled || pinned
      ? []
      : await loadEnvironmentContextFiles(env, location, signal)
  const remoteHome = local
    ? undefined
    : await env.absolutePath('~/.vela/skills', signal)
  if (remoteHome && !remoteHome.ok) throw remoteHome.error
  const workspaceSkills = (
    workspaceMode === undefined
      ? explicitSkills
      : workspaceMode === 'none'
  )
    ? []
    : await loadEnvironmentSkills(
        env,
        location,
        signal,
        workspaceMode === 'home',
        ({ path, message }) => logger.warn(`[resources] ${path}: ${message}`),
        local ? (settings.skills ?? []) : [remoteHome!.value],
      )
  const workspaceNames = new Set(workspaceSkills.map((skill) => skill.name))
  const hostSkills = local ? host.skills : []
  const skills = [
    ...workspaceSkills,
    ...hostSkills.filter((skill) => !workspaceNames.has(skill.name)),
  ]
  const workspaceTemplates = (
    workspaceMode === undefined
      ? explicitTemplates
      : workspaceMode !== 'all'
  )
    ? []
    : await loadEnvironmentTemplates(
        env,
        location,
        signal,
        settings.prompts ?? [],
      )
  const templateNames = new Set(
    workspaceTemplates.map((template) => template.name),
  )
  const selectedTemplates = [
    ...workspaceTemplates,
    ...(local ? host.promptTemplates : []).filter(
      (template) => !templateNames.has(template.name),
    ),
  ]
  const readSystem = (name: 'SYSTEM.md' | 'APPEND_SYSTEM.md') =>
    sessionSystemFile(
      env,
      name,
      workspaceMode === 'all',
      split?.agentDir,
      signal,
    )
  return {
    systemPrompt: host.systemPrompt ?? (await readSystem('SYSTEM.md')),
    appendSystemPrompt:
      host.appendSystemPrompt ?? (await readSystem('APPEND_SYSTEM.md')),
    skills,
    promptTemplates: selectedTemplates,
    contextFiles: !contextEnabled
      ? []
      : split
        ? [
            ...split.userContextFiles,
            ...workspace.filter(
              (item) =>
                !local ||
                !split.userContextFiles.some((host) => host.path === item.path),
            ),
          ]
        : pinned
          ? host.contextFiles
          : workspace,
  }
}
