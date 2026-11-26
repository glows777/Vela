import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { VelaSettings } from '../../config/index.ts'
import { openDatabase, type VelaDatabase } from '../../db/index.ts'
import type { VelaLogger } from '../../shared/logger.ts'
import type { ConfigResourceSplit } from '../config/runtime-resources.ts'
import {
  createSessionLocalExecutionEnv,
  scopeLocalResults,
} from '../execution/local.ts'
import {
  type ExecutionEnv,
  type ExecutionLocation,
  executionEnvOs,
  type InternalExecutionEnv,
} from '../execution/types.ts'
import {
  registerMemoryDatabase,
  unregisterMemoryDatabase,
} from '../memory/db-registry.ts'
import { loadEnvironmentContextFiles } from '../prompt/environment-context-files.ts'
import { loadEnvironmentTemplates } from '../prompt/environment-templates.ts'
import { loadEnvironmentSkills } from '../skills/environment-skills.ts'
import { readEnvironmentInventory } from './environment-inventory.ts'
import type { ProjectConfig } from './project-config.ts'
import { type SessionResources, sessionSystemFile } from './resources.ts'
import { type InventoryEnv, workspaceDiscovery } from './workspace-discovery.ts'

export function workspaceKey(id: string, location: ExecutionLocation) {
  return JSON.stringify([id, location.environment, location.cwd])
}

export function syncSessionNetwork(
  session: {
    registry: { setRestrictedNetwork(restricted: boolean): void }
    location: ExecutionLocation
  },
  envNetworkMode?: (environment: string) => 'on' | 'off' | 'restricted',
) {
  session.registry.setRestrictedNetwork(
    (envNetworkMode?.(session.location.environment) ?? 'on') !== 'on',
  )
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
      workspaceMode === 'all',
      split?.agentDir,
      signal,
    )
  if (!local) {
    if (workspaceMode === 'none') {
      return {
        systemPrompt: host.systemPrompt ?? (await readSystem('SYSTEM.md')),
        appendSystemPrompt:
          host.appendSystemPrompt ?? (await readSystem('APPEND_SYSTEM.md')),
        skills: [],
        promptTemplates: [],
        contextFiles: contextEnabled
          ? [...(split?.userContextFiles ?? [])]
          : [],
      }
    }
    const batch = (env as InventoryEnv)[workspaceDiscovery]
    const declaredSkills = settings.skills ?? []
    const declaredPrompts = settings.prompts ?? []
    const result = batch
      ? await batch(contextEnabled, signal, declaredSkills, declaredPrompts)
      : await readEnvironmentInventory(
          env,
          contextEnabled,
          signal,
          declaredSkills,
          declaredPrompts,
        )
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
  db: VelaDatabase & { close(): void }
  ownsDb: boolean
  ephemeral: boolean
  dataDir: string
  beforeDispose?: () => Promise<void> | void
}): Promise<void> {
  try {
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
  } finally {
    unregisterMemoryDatabase(options.dataDir, options.db)
  }
}

export function openVelaStorage(options: {
  cwd?: string
  agentDir?: string
  dataDir?: string
  db?: VelaDatabase
  ephemeralSessions?: boolean
}): {
  cwd: string
  agentDir?: string
  ephemeral: boolean
  ephemeralSessions: boolean
  dataDir: string
  blobsDir: string
  ownsDb: boolean
  db: VelaDatabase
} {
  if (
    options.ephemeralSessions === true &&
    options.db &&
    options.db.path !== ':memory:'
  ) {
    throw new Error(
      'Cannot combine ephemeralSessions: true with a persistent db',
    )
  }
  const cwd = resolve(options.cwd ?? process.cwd())
  const agentDir = options.agentDir ? resolve(options.agentDir) : undefined
  const ephemeral = options.dataDir === undefined
  const ephemeralSessions =
    options.ephemeralSessions === true ||
    (ephemeral && !options.db && !agentDir)
  const dataDir = ephemeral
    ? mkdtempSync(join(tmpdir(), 'vela-'))
    : resolve(cwd, options.dataDir as string)
  const dbDir = agentDir ?? dataDir
  const blobsDir = ephemeralSessions
    ? join(dataDir, 'blobs')
    : join(dbDir, 'blobs')
  const ownsDb = !options.db
  try {
    const db =
      options.db ??
      openDatabase({
        path: ephemeralSessions ? ':memory:' : join(dbDir, 'vela.db'),
      })
    registerMemoryDatabase(dataDir, db)
    return {
      cwd,
      agentDir,
      ephemeral,
      ephemeralSessions,
      dataDir,
      blobsDir,
      ownsDb,
      db,
    }
  } catch (error) {
    if (ephemeral) rmSync(dataDir, { recursive: true, force: true })
    throw error
  }
}

export function cleanupFailedVelaInit(
  ownsDb: boolean,
  db: VelaDatabase,
  ephemeral: boolean,
  dataDir: string,
): void {
  if (ownsDb && db.open) db.close()
  if (ephemeral) rmSync(dataDir, { recursive: true, force: true })
}

export async function resolveSessionExecution(params: {
  sessionId: string
  location: ExecutionLocation
  spillDir?: string
  envResolver?: (target: {
    sessionId: string
    location: ExecutionLocation
  }) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>
  shellPath?: string
  dataDir: string
  resourceSplit?: ConfigResourceSplit
  projectConfig: ProjectConfig
  identities: Map<string, string>
  sessionOs: Map<string, string>
  sessionShells: Map<string, string | undefined>
  signal?: AbortSignal
}): Promise<ExecutionEnv> {
  const { sessionId, location, signal } = params
  const key = workspaceKey(sessionId, location)
  const local = location.environment === 'local'
  const resolver =
    local && params.resourceSplit?.useBuiltinLocal
      ? undefined
      : params.envResolver
  let env = resolver
    ? await resolver({ sessionId, location })
    : local
      ? createSessionLocalExecutionEnv({
          cwd: location.cwd,
          shellPath: params.shellPath,
          tempRoot:
            params.spillDir ??
            join(params.dataDir, 'sessions', sessionId, 'tool-results'),
        })
      : undefined
  signal?.throwIfAborted()
  if (
    !env?.id ||
    (env.id === 'node:local') !== local ||
    env.cwd !== location.cwd ||
    (params.identities.has(key) && params.identities.get(key) !== env.id)
  )
    throw new Error(
      `Execution environment unavailable for ${location.environment}:${location.cwd}`,
    )
  params.identities.set(key, env.id)
  const detectedOs = (env as InternalExecutionEnv)[executionEnvOs]
  if (detectedOs) params.sessionOs.set(key, detectedOs)
  if (local && params.resourceSplit) {
    const settings = await params.projectConfig.get(key, env, 'local')
    const shellPath =
      params.shellPath ??
      settings.shellPath ??
      params.resourceSplit.fallbackShellPath
    signal?.throwIfAborted()
    params.sessionShells.set(key, shellPath)
    if (!resolver && shellPath !== params.shellPath)
      env = createSessionLocalExecutionEnv({
        cwd: location.cwd,
        shellPath,
        tempRoot:
          params.spillDir ??
          join(params.dataDir, 'sessions', sessionId, 'tool-results'),
      })
  }
  return local && resolver && params.spillDir
    ? scopeLocalResults(env, params.spillDir)
    : env
}
