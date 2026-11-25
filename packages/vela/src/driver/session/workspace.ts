import { rmSync } from 'node:fs'
import type { VelaSettings } from '../../config/index.ts'
import type { VelaLogger } from '../../shared/logger.ts'
import type { ConfigResourceSplit } from '../config/runtime-resources.ts'
import type { ExecutionEnv, ExecutionLocation } from '../execution/types.ts'
import { loadEnvironmentContextFiles } from '../prompt/environment-context-files.ts'
import { loadEnvironmentTemplates } from '../prompt/environment-templates.ts'
import { loadEnvironmentSkills } from '../skills/environment-skills.ts'
import { readEnvironmentInventory } from './environment-inventory.ts'
import { type SessionResources, sessionSystemFile } from './resources.ts'
import { type InventoryEnv, workspaceDiscovery } from './workspace-discovery.ts'

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
  const location = env.cwd
  const local = env.id === 'node:local'
  const readSystem = (name: 'SYSTEM.md' | 'APPEND_SYSTEM.md') =>
    sessionSystemFile(
      env,
      name,
      local && workspaceMode === 'all',
      split?.agentDir,
      signal,
    )
  if (!local) {
    const batch = (env as InventoryEnv)[workspaceDiscovery]
    const result = batch
      ? await batch(contextEnabled, signal)
      : await readEnvironmentInventory(env, contextEnabled, signal)
    for (const { path, message } of result.diagnostics)
      logger.warn(`[resources] ${path}: ${message}`)
    return {
      systemPrompt: host.systemPrompt ?? (await readSystem('SYSTEM.md')),
      appendSystemPrompt:
        host.appendSystemPrompt ?? (await readSystem('APPEND_SYSTEM.md')),
      skills: result.skills,
      promptTemplates: result.promptTemplates,
      contextFiles: contextEnabled
        ? [...(split?.userContextFiles ?? []), ...result.contextFiles]
        : [],
    }
  }
  const workspace =
    !contextEnabled || pinned
      ? []
      : await loadEnvironmentContextFiles(env, location, signal)
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
        settings.skills ?? [],
      )
  const workspaceNames = new Set(workspaceSkills.map((skill) => skill.name))
  const skills = [
    ...workspaceSkills,
    ...host.skills.filter((skill) => !workspaceNames.has(skill.name)),
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
    ...host.promptTemplates.filter(
      (template) => !templateNames.has(template.name),
    ),
  ]
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
                !split.userContextFiles.some((host) => host.path === item.path),
            ),
          ]
        : pinned
          ? host.contextFiles
          : workspace,
  }
}

/** Shared shutdown helper for createVela(). */
export async function disposeVelaRuntime(options: {
  settled: Promise<unknown>
  shutdownRunner: () => Promise<void>
  sessions: Iterable<{ close(): Promise<void> | void }>
  listeners: { clear(): void }
  db: { close(): void }
  ownsDb: boolean
  ephemeral: boolean
  dataDir: string
  beforeDispose?: () => Promise<void> | void
}): Promise<void> {
  await options.settled
  const errors: unknown[] = []
  try {
    await options.beforeDispose?.()
  } catch (error) {
    errors.push(error)
  }
  const closed = await Promise.allSettled(
    [...options.sessions].map((s) => Promise.resolve().then(() => s.close())),
  )
  for (const result of closed) {
    if (result.status === 'rejected') errors.push(result.reason)
  }
  try {
    await options.shutdownRunner()
  } catch (error) {
    errors.push(error)
  }
  options.listeners.clear()
  if (options.ownsDb) {
    try {
      options.db.close()
    } catch (error) {
      errors.push(error)
    }
  }
  if (options.ephemeral) {
    try {
      rmSync(options.dataDir, { recursive: true, force: true })
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Vela disposal failed')
}
