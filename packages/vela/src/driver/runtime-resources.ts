import type { VelaDatabase } from '../db/index.ts'
import { savedTrust } from '../db/trust.ts'
import type {
  MemoryDirs,
  MemoryRegistry,
  MemoryStore,
} from '../runtime/memory/index.ts'
import { resolveMemoryDirs } from '../runtime/memory/index.ts'
import { loadProjectSettings } from './config/project-settings.ts'
import type { ExecutionEnv, ExecutionLocation } from './execution/types.ts'
import {
  serperSearchTool,
  tavilySearchTool,
  webFetchTool,
} from './extensions/web/tools.ts'
import type { ModelMessage } from './messages.ts'
import type { ContextFile } from './prompt/context-files.ts'
import { loadEnvironmentContextFiles } from './prompt/environment-context-files.ts'
import { loadEnvironmentTemplates } from './prompt/environment-templates.ts'
import type { PromptTemplate } from './prompt/templates.ts'
import type { SessionStore } from './session/index.ts'
import { messageText } from './session/message-queue.ts'
import { canonicalEnvironmentPath } from './session/project-config.ts'
import { loadEnvironmentSkills } from './skills/environment-skills.ts'
import type { SkillDefinition } from './skills/loader.ts'
import type { ToolDefinition } from './tools/registry.ts'

const EMPTY_MEMORY_MESSAGE =
  '[memory] No memories stored yet. Use the memory tool to save important information.'

export interface TrustedRuntimeResources {
  trusted: boolean
  contextFiles: ContextFile[]
  skills: SkillDefinition[]
  promptTemplates: PromptTemplate[]
}

/**
 * Resolves whether a Runtime session's workspace is trusted (`trusted_paths`) and loads
 * workspace `AGENTS.md`, skills, and prompt templates only when trusted.
 */
export async function loadTrustedRuntimeResources(options: {
  db: VelaDatabase
  agentDir: string
  location: ExecutionLocation
  resolveEnv: () => Promise<ExecutionEnv>
  signal: AbortSignal
  hostContextFiles?: readonly ContextFile[]
  hostSkills?: readonly SkillDefinition[]
  hostPromptTemplates?: readonly PromptTemplate[]
  hostEnv?: Record<string, string | undefined>
  trustOverride?: boolean
}): Promise<TrustedRuntimeResources> {
  const contextFiles: ContextFile[] = [...(options.hostContextFiles ?? [])]
  const skillsByName = new Map<string, SkillDefinition>()
  for (const skill of options.hostSkills ?? []) {
    skillsByName.set(skill.name, skill)
  }
  const templatesByName = new Map<string, PromptTemplate>()
  for (const tpl of options.hostPromptTemplates ?? []) {
    templatesByName.set(tpl.name, tpl)
  }

  let env: ExecutionEnv | undefined
  let targetCwd = options.location.cwd
  let trusted: boolean
  if (options.trustOverride !== undefined) {
    trusted = options.trustOverride
  } else if (options.location.environment === 'local') {
    trusted =
      savedTrust(options.db, options.location, options.agentDir) === true
  } else {
    env = await options.resolveEnv()
    targetCwd = await canonicalEnvironmentPath(
      env,
      options.location.cwd,
      options.signal,
    )
    trusted =
      savedTrust(
        options.db,
        { environment: options.location.environment, cwd: targetCwd },
        options.agentDir,
      ) === true
  }

  if (!trusted) {
    return {
      trusted: false,
      contextFiles,
      skills: [...skillsByName.values()],
      promptTemplates: [...templatesByName.values()],
    }
  }

  env ??= await options.resolveEnv()
  if (
    options.location.environment !== 'local' &&
    targetCwd === options.location.cwd
  ) {
    targetCwd = await canonicalEnvironmentPath(
      env,
      options.location.cwd,
      options.signal,
    )
  }
  const project = await loadProjectSettings(env, {
    cwd: targetCwd,
    trusted: true,
    agentDir: options.agentDir,
    env: options.hostEnv ?? {},
    signal: options.signal,
  })
  const loadedContext = await loadEnvironmentContextFiles(
    env,
    targetCwd,
    options.signal,
  )
  const seenPaths = new Set(contextFiles.map((f) => f.path))
  for (const file of loadedContext) {
    if (!seenPaths.has(file.path)) {
      seenPaths.add(file.path)
      contextFiles.push(file)
    }
  }

  const loadedSkills = await loadEnvironmentSkills(
    env,
    targetCwd,
    options.signal,
    false,
    () => {},
    project.skillDirs,
  )
  for (const skill of loadedSkills) {
    skillsByName.set(skill.name, skill)
  }

  const loadedTemplates = await loadEnvironmentTemplates(
    env,
    targetCwd,
    options.signal,
    project.promptDirs,
  )
  for (const tpl of loadedTemplates) {
    templatesByName.set(tpl.name, tpl)
  }

  return {
    trusted: true,
    contextFiles,
    skills: [...skillsByName.values()],
    promptTemplates: [...templatesByName.values()],
  }
}

function promptLayer(label: string, store: MemoryStore): string | null {
  const index = store.buildIndex(4000 - label.length - 2)
  return index ? `${label}:\n${index}` : null
}

/**
 * Formats the `[memory]` custom message content for a Runtime session (project-local + read-only global
 * for project sessions, or global for standalone sessions).
 */
export function resolveRuntimeMemoryStores(options: {
  registry: MemoryRegistry
  agentDir: string
  projectId: string | null
  cwd: string
}): { local: MemoryStore; global: MemoryStore; dirs: MemoryDirs } {
  const dirs = resolveMemoryDirs(options.agentDir, options.projectId)
  const { local, global } = options.registry.forSession(
    options.agentDir,
    options.projectId,
    options.cwd,
  )
  return { local, global, dirs }
}

export function formatRuntimeMemoryContent(options: {
  local: MemoryStore
  global: MemoryStore
  isProject: boolean
  hadPreviousMemoryMessage: boolean
}): string | null {
  const index = options.isProject
    ? [
        promptLayer('Project memory', options.local),
        promptLayer(
          'Global notes (read/search with scope: global; project writes stay in project memory)',
          options.global,
        ),
      ]
        .filter(Boolean)
        .join('\n\n')
    : options.local.buildIndex()

  if (index) return index
  return options.hadPreviousMemoryMessage ? EMPTY_MEMORY_MESSAGE : null
}

/** Looks up the latest active-branch `custom_message` of `customType` stored in `vela_messages`. */
export function lastActiveCustomMessageText(options: {
  db: VelaDatabase
  sessionId: string
  messages: readonly ModelMessage[]
  store: SessionStore
  customType: string
}): string | undefined {
  const activeIds = options.messages
    .map((m) => options.store.idOf(m))
    .filter((id): id is string => typeof id === 'string')
  if (activeIds.length === 0) return undefined
  const placeholders = activeIds.map(() => '?').join(', ')
  const rows = options.db.all<{ id: string; content_json: string }>(
    `SELECT id, content_json FROM vela_messages
     WHERE session_id = ? AND kind = 'custom_message' AND id IN (${placeholders})`,
    options.sessionId,
    ...activeIds,
  )
  if (rows.length === 0) return undefined
  const byId = new Map(rows.map((r) => [r.id, r.content_json]))
  for (let i = options.messages.length - 1; i >= 0; i--) {
    const id = options.store.idOf(options.messages[i]!)
    if (!id) continue
    const raw = byId.get(id)
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw) as { customType?: string }
      if (parsed.customType === options.customType) {
        return messageText(options.messages[i]!)
      }
    } catch {
      /* ignore malformed custom_message */
    }
  }
  return undefined
}

/** Creates `web_fetch` and `web_search` tools for Runtime sessions. */
export function createRuntimeWebTools(options: {
  webConfig?: Record<string, unknown>
  hostEnv?: Record<string, string | undefined>
  offline?: boolean
}): ToolDefinition[] {
  if (options.offline) return []
  const tavilyKey =
    (typeof options.webConfig?.tavilyKey === 'string' &&
      options.webConfig.tavilyKey) ||
    options.hostEnv?.TAVILY_API_KEY
  const serperKey =
    (typeof options.webConfig?.serperKey === 'string' &&
      options.webConfig.serperKey) ||
    options.hostEnv?.SERPER_API_KEY

  const fetchTool: ToolDefinition = {
    ...webFetchTool,
    name: 'web_fetch',
  }
  const searchTool: ToolDefinition = tavilyKey
    ? { ...tavilySearchTool(tavilyKey), name: 'web_search' }
    : serperKey
      ? { ...serperSearchTool(serperKey), name: 'web_search' }
      : {
          ...tavilySearchTool(''),
          name: 'web_search',
          hostedOnly: true as const,
        }
  return [fetchTool, searchTool]
}
