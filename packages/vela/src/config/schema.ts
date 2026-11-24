import { z } from 'zod'
import {
  deepMerge,
  interpolateDeep,
  isPlainObject,
} from '../shared/interpolate.ts'
import { assertLimitKeys, type VelaLimits } from '../shared/limits.ts'
import {
  PROVIDER_APIS,
  type ProviderConfig,
  THINKING_LEVELS,
  type ThinkingLevel,
} from '../shared/provider-types.ts'
import { isToolModifier, mergeDefaultTools } from '../shared/tool-selection.ts'

/** Contents of `config.json` (user: `~/.vela/config.json`, project: `<cwd>/.vela/config.json`). */
export interface VelaSettings {
  /** Default model `provider/id` */
  model?: string
  /** Default thinking level; medium when unset (like pi) */
  thinkingLevel?: ThinkingLevel
  /**
   * Models Ctrl+P cycles through (pi's `enabledModels`): `provider/id` patterns where `*` matches anything,
   * or a bare id / pattern matched against every provider. Unset: all available models.
   */
  enabledModels?: string[]
  /**
   * Tools a new session starts with: plain names (or `*` patterns) replace the default set, while
   * `+name` / `-name` entries adjust it (like pi's `defaultTools`).
   */
  tools?: string[]
  /** Model providers merged on top of built-in providers (`anthropic`, `openai`, `openrouter`, `deepseek`). */
  providers?: Record<string, ProviderConfig>
  /** MCP server configurations keyed by server name. */
  mcpServers?: Record<string, unknown>
  /** Host-owned execution environment definitions (e.g. Docker containers). */
  environments?: Record<string, unknown>
  /** Host-owned default execution location (reserved for future CLI default placement; not yet applied at startup). */
  location?: { environment: string; cwd?: string }
  /** Built-in Lark channel configuration; strings support `$VAR` / `${VAR}`. */
  lark?: Record<string, unknown>
  /** Built-in web tool configuration (`tavilyKey`, `serperKey`); strings support `$VAR` / `${VAR}`. */
  web?: Record<string, unknown>
  /** Built-in memory extension configuration (`dream`); strings support `$VAR` / `${VAR}`. */
  memory?: Record<string, unknown>
  /** Overrides any subset of VelaLimits */
  limits?: Partial<VelaLimits>
  /** Automatic compaction (like pi's `compaction.enabled`); default true. Manual /compact works either way */
  autoCompaction?: boolean
  /** Shell the bash tool runs commands with (like pi); the CLI selects Git Bash on Windows */
  shellPath?: string
  /** Project data directory, relative to cwd; default `<agentDir>/projects/<encoded cwd>` */
  dataDir?: string
  /** Extra skill directories or files (relative to this config file) */
  skills?: string[]
  /** Extra prompt template directories or files (relative to this config file) */
  prompts?: string[]
  /** Extension files or directories (relative to this config file), plus `builtin:<name>` / `+builtin:<name>` / `-builtin:<name>` */
  extensions?: string[]
  /** Transitional HTTP webhook receiver settings (replaces `extensionConfig.channel.eventReceiver` until S4b). */
  webhooks?: Record<string, unknown>
  /** Unmatched external events fallback target (`{ channel, chatId }`). */
  eventDefaultTarget?: { channel: string; chatId: string }
  /** Transitional local HTTP channel listener settings (until S4b removes `legacy-channels`). */
  local?: Record<string, unknown>
  /** Third-party custom extension sections keyed by extension name; strings support `$VAR` / `${VAR}`. */
  extensionConfig?: Record<string, Record<string, unknown>>
}

export const RESOURCE_KEYS = ['extensions', 'skills', 'prompts'] as const

/** Host-level privileged keys that `<cwd>/.vela/config.json` must never override. */
export const PROJECT_PRIVILEGED_KEYS = [
  'environments',
  'location',
  'providers',
  'lark',
  'local',
  'webhooks',
  'eventDefaultTarget',
] as const

const RESERVED_EXTENSION_SECTIONS = new Map<string, string | null>([
  ['lark', 'lark'],
  ['web', 'web'],
  ['mcp', 'mcpServers'],
  ['memory', 'memory'],
  ['channel', 'webhooks'],
  ['local', 'local'],
  ['background', null],
  ['todo', null],
])

const INTERPOLATED_SECTIONS = [
  'lark',
  'web',
  'memory',
  'webhooks',
  'local',
  'extensionConfig',
] as const

/**
 * Formats a JSON syntax failure without echoing raw source snippets or attaching the native
 * error cause, which may contain pasted credentials in Node or Bun.
 */
export function formatJsonParseError(
  file: string,
  text: string,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error)
  const lineCol = /line\s+(\d+)\s*(?:,|\s)\s*(?:column|col)\s+(\d+)/i.exec(
    message,
  )
  if (lineCol) {
    return `${file} is not valid JSON (line ${lineCol[1]}, column ${lineCol[2]})`
  }
  const posMatch = /\bposition\s+(\d+)/i.exec(message)
  if (posMatch) {
    const pos = Math.min(Number(posMatch[1]), text.length)
    let line = 1
    let col = 1
    for (let i = 0; i < pos; i++) {
      if (text.charCodeAt(i) === 10) {
        line++
        col = 1
      } else col++
    }
    return `${file} is not valid JSON (line ${line}, column ${col})`
  }
  return `${file} is not valid JSON`
}

function validateCompat(value: unknown, label: string): void {
  if (value === undefined) return
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`)
  if (
    value.hostedTools !== undefined &&
    (!Array.isArray(value.hostedTools) ||
      value.hostedTools.some((tool) => tool !== 'web_search'))
  )
    throw new Error(
      `${label}.hostedTools must be an array containing only web_search`,
    )
  for (const key of [
    'store',
    'includeWebSearchSources',
    'supportsDeveloperRole',
    'deepseekReasoningStream',
  ] as const)
    if (value[key] !== undefined && typeof value[key] !== 'boolean')
      throw new Error(`${label}.${key} must be a boolean`)
}

const COST_KEYS = ['input', 'output', 'cacheWrite', 'cacheRead'] as const

function validateModelSpec(
  model: unknown,
  label: string,
  requireId = true,
): void {
  if (!isPlainObject(model) || (requireId && typeof model.id !== 'string'))
    throw new Error(`${label} must be an object with a string id`)
  if (model.id !== undefined && typeof model.id !== 'string')
    throw new Error(`${label}.id must be a string`)
  if (model.name !== undefined && typeof model.name !== 'string')
    throw new Error(`${label}.name must be a string`)
  for (const key of ['contextWindow', 'maxTokens'] as const) {
    const v = model[key]
    if (
      v !== undefined &&
      (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)
    )
      throw new Error(`${label}.${key} must be a positive number`)
  }
  if (model.reasoning !== undefined && typeof model.reasoning !== 'boolean')
    throw new Error(`${label}.reasoning must be a boolean`)
  if (
    model.input !== undefined &&
    (!Array.isArray(model.input) ||
      model.input.some((item) => typeof item !== 'string'))
  )
    throw new Error(`${label}.input must be an array of strings`)
  if (model.thinkingLevelMap !== undefined) {
    if (!isPlainObject(model.thinkingLevelMap))
      throw new Error(`${label}.thinkingLevelMap must be an object`)
    for (const [level, mapped] of Object.entries(model.thinkingLevelMap)) {
      if (!(THINKING_LEVELS as readonly string[]).includes(level))
        throw new Error(
          `${label}.thinkingLevelMap has unknown level "${level}"`,
        )
      if (mapped !== null && typeof mapped !== 'string')
        throw new Error(
          `${label}.thinkingLevelMap.${level} must be a string or null`,
        )
    }
  }
  if (model.cost !== undefined) {
    if (!isPlainObject(model.cost))
      throw new Error(`${label}.cost must be an object`)
    for (const key of Object.keys(model.cost))
      if (!(COST_KEYS as readonly string[]).includes(key))
        throw new Error(`${label}.cost has unknown key "${key}"`)
    for (const key of COST_KEYS) {
      const v = model.cost[key]
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
        throw new Error(
          `${label}.cost.${key} must be a non-negative finite number`,
        )
    }
  }
  validateCompat(model.compat, `${label}.compat`)
}

function validateLimits(limits: Record<string, unknown>, label: string): void {
  assertLimitKeys(limits, label)
  for (const [key, value] of Object.entries(limits)) {
    if (key === 'microcompact') {
      if (typeof value !== 'boolean')
        throw new Error(`${label}.${key} must be a boolean`)
    } else if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0
    ) {
      throw new Error(`${label}.${key} must be a non-negative finite number`)
    }
  }
}

/** Validate a `providers` record from `config.json` with clear file-prefixed messages. */
function validateProvidersRecord(
  providers: unknown,
  file: string,
): Record<string, ProviderConfig> {
  if (providers === undefined) return {}
  if (!isPlainObject(providers))
    throw new Error(`${file}: providers must be an object`)
  for (const [name, config] of Object.entries(providers)) {
    if (!isPlainObject(config))
      throw new Error(`${file}: providers.${name} must be an object`)
    if (
      config.api !== undefined &&
      !PROVIDER_APIS.includes(config.api as (typeof PROVIDER_APIS)[number])
    )
      throw new Error(
        `${file}: providers.${name}.api must be one of ${PROVIDER_APIS.join(' / ')}`,
      )
    if (config.baseUrl !== undefined && typeof config.baseUrl !== 'string')
      throw new Error(`${file}: providers.${name}.baseUrl must be a string`)
    if (config.apiKey !== undefined && typeof config.apiKey !== 'string')
      throw new Error(`${file}: providers.${name}.apiKey must be a string`)
    if (
      config.headers !== undefined &&
      (!isPlainObject(config.headers) ||
        Object.values(config.headers).some((v) => typeof v !== 'string'))
    )
      throw new Error(
        `${file}: providers.${name}.headers must be an object of strings`,
      )
    validateCompat(config.compat, `${file}: providers.${name}.compat`)
    const models = config.models
    if (
      models !== undefined &&
      (!Array.isArray(models) ||
        models.some((m) => !isPlainObject(m) || typeof m.id !== 'string'))
    )
      throw new Error(
        `${file}: providers.${name}.models must be an array of objects with an id`,
      )
    if (Array.isArray(models))
      for (const [index, model] of models.entries())
        validateModelSpec(model, `${file}: providers.${name}.models[${index}]`)
  }
  return providers as Record<string, ProviderConfig>
}

const configObjectSchema = z.strictObject({
  model: z.string().optional(),
  thinkingLevel: z.string().optional(),
  enabledModels: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  providers: z.record(z.string(), z.unknown()).optional(),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  environments: z.record(z.string(), z.unknown()).optional(),
  location: z
    .strictObject({
      environment: z.string().min(1),
      cwd: z.string().optional(),
    })
    .optional(),
  lark: z.record(z.string(), z.unknown()).optional(),
  web: z.record(z.string(), z.unknown()).optional(),
  memory: z.record(z.string(), z.unknown()).optional(),
  limits: z.record(z.string(), z.unknown()).optional(),
  autoCompaction: z.boolean().optional(),
  shellPath: z.string().optional(),
  dataDir: z.string().optional(),
  skills: z.array(z.string()).optional(),
  prompts: z.array(z.string()).optional(),
  extensions: z.array(z.string()).optional(),
  webhooks: z.record(z.string(), z.unknown()).optional(),
  eventDefaultTarget: z.unknown().optional(),
  local: z.record(z.string(), z.unknown()).optional(),
  extensionConfig: z.record(z.string(), z.unknown()).optional(),
})

/** Strip host-level privileged keys from a project `.vela/config.json` layer. */
export function stripProjectPrivilegedKeys(settings: VelaSettings): void {
  for (const key of PROJECT_PRIVILEGED_KEYS)
    if (key in settings) delete settings[key]
}

/** Parse and strictly validate `config.json` without filesystem access; callers own path resolution. */
export function parseConfig(
  text: string,
  file: string,
  resolvePath: (path: string) => string = (path) => path,
  options: { layer?: 'user' | 'project' } = {},
): VelaSettings {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(text)
  } catch (error) {
    throw new Error(formatJsonParseError(file, text, error))
  }
  if (!isPlainObject(parsedJson))
    throw new Error(`${file} must be a JSON object`)

  // Drop owner-only keys before validation on project layers so ignored host fields never break startup.
  const raw: Record<string, unknown> =
    options.layer === 'project' ? { ...parsedJson } : parsedJson
  if (options.layer === 'project') {
    for (const key of PROJECT_PRIVILEGED_KEYS) delete raw[key]
  }

  // Check common array/object/scalar fields with clear file-scoped diagnostics before/alongside Zod strict check.
  for (const key of RESOURCE_KEYS) {
    const list = raw[key]
    if (list !== undefined) {
      if (!Array.isArray(list) || list.some((item) => typeof item !== 'string'))
        throw new Error(`${file}: ${key} must be an array of strings`)
    }
  }
  for (const key of ['enabledModels', 'tools'] as const) {
    const list = raw[key]
    if (
      list !== undefined &&
      (!Array.isArray(list) || list.some((item) => typeof item !== 'string'))
    )
      throw new Error(`${file}: ${key} must be an array of strings`)
  }
  for (const key of [
    'limits',
    'lark',
    'web',
    'memory',
    'mcpServers',
    'environments',
    'webhooks',
    'local',
    'extensionConfig',
  ] as const) {
    if (raw[key] !== undefined && !isPlainObject(raw[key]))
      throw new Error(`${file}: ${key} must be an object`)
  }
  for (const key of ['dataDir', 'shellPath'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string')
      throw new Error(`${file}: ${key} must be a string`)
  }
  if (
    raw.autoCompaction !== undefined &&
    typeof raw.autoCompaction !== 'boolean'
  )
    throw new Error(`${file}: autoCompaction must be true or false`)
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string')
      throw new Error(`${file}: model must be "provider/id"`)
    const slash = raw.model.indexOf('/')
    if (slash <= 0 || slash === raw.model.length - 1)
      throw new Error(`${file}: model must be "provider/id"`)
  }
  if (
    raw.thinkingLevel !== undefined &&
    (typeof raw.thinkingLevel !== 'string' ||
      !(THINKING_LEVELS as readonly string[]).includes(raw.thinkingLevel))
  )
    throw new Error(
      `${file}: thinkingLevel must be one of ${THINKING_LEVELS.join(' / ')}`,
    )

  const parsed = configObjectSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    if (issue.code === 'unrecognized_keys' && issue.keys.length > 0) {
      const prefix = issue.path.length ? `${issue.path.join('.')}: ` : ''
      throw new Error(
        `${file}: ${prefix}unknown key ${issue.keys.map((k) => `"${k}"`).join(', ')}`,
      )
    }
    const where = issue.path.length ? `${issue.path.join('.')}: ` : ''
    throw new Error(`${file}: ${where}${issue.message}`)
  }

  const settings = { ...parsed.data } as VelaSettings
  if (settings.limits !== undefined)
    validateLimits(settings.limits, `${file}: limits`)
  if (settings.providers !== undefined)
    validateProvidersRecord(settings.providers, file)

  const toolPattern = settings.tools?.find(
    (entry) => isToolModifier(entry) && entry.includes('*'),
  )
  if (toolPattern)
    throw new Error(
      `${file}: +name and -name entries take exact tool names, not patterns: ${toolPattern}`,
    )

  const target = raw.eventDefaultTarget
  if (target !== undefined) {
    if (
      !isPlainObject(target) ||
      Object.keys(target).some(
        (key) => key !== 'channel' && key !== 'chatId',
      ) ||
      typeof target.channel !== 'string' ||
      !target.channel.trim() ||
      typeof target.chatId !== 'string' ||
      !target.chatId.trim()
    )
      throw new Error(
        `${file}: eventDefaultTarget must be { channel, chatId } with nonempty strings`,
      )
    settings.eventDefaultTarget = {
      channel: target.channel.trim(),
      chatId: target.chatId.trim(),
    }
  }

  if (settings.extensionConfig !== undefined) {
    for (const [name, section] of Object.entries(settings.extensionConfig)) {
      if (RESERVED_EXTENSION_SECTIONS.has(name)) {
        const topLevel = RESERVED_EXTENSION_SECTIONS.get(name)
        throw new Error(
          topLevel
            ? `${file}: extensionConfig.${name} is a built-in section; move it to top-level "${topLevel}"`
            : `${file}: extensionConfig.${name} is a built-in extension with no config section; remove it from extensionConfig`,
        )
      }
      if (!isPlainObject(section))
        throw new Error(`${file}: extensionConfig.${name} must be an object`)
    }
  }

  for (const key of RESOURCE_KEYS) {
    const list = settings[key]
    if (!list) continue
    settings[key] = list.map((item) =>
      /^[+-]?builtin:/.test(item) ? item : resolvePath(item),
    )
  }

  return settings
}

/**
 * Single-pass `$VAR` interpolation for one raw config layer before merging.
 * Deliberately leaves `environments` (Docker credential `$VAR` refs), `mcpServers` (strict `${VAR}`
 * resolver), and `providers` (per-provider interpolator & `authSource` `$VAR` labels) verbatim.
 */
export function interpolateConfigLayer(
  settings: VelaSettings,
  env: Record<string, string | undefined>,
): VelaSettings {
  const next: VelaSettings = { ...settings }
  for (const key of INTERPOLATED_SECTIONS) {
    const value = next[key]
    if (value !== undefined)
      (next as Record<string, unknown>)[key] = interpolateDeep(value, env)
  }
  return next
}

const MCP_OVERRIDE_KEYS = new Set(['enabled', 'exposure', 'toolExposure'])

/** Project overrides user: objects deep-merge, mcpServers follow transport replacement/exposure rules, resource lists concatenate. */
export function mergeConfig(
  base: VelaSettings,
  override: VelaSettings,
): VelaSettings {
  const merged = deepMerge(base, override) as VelaSettings
  if (base.mcpServers !== undefined || override.mcpServers !== undefined) {
    const nextMcp: Record<string, unknown> = { ...(base.mcpServers ?? {}) }
    if (override.mcpServers) {
      for (const [name, raw] of Object.entries(override.mcpServers)) {
        const existing = nextMcp[name]
        if (
          isPlainObject(raw) &&
          isPlainObject(existing) &&
          raw.command === undefined &&
          raw.url === undefined &&
          raw.type === undefined &&
          Object.keys(raw).every((k) => MCP_OVERRIDE_KEYS.has(k))
        ) {
          nextMcp[name] = { ...existing, ...raw }
        } else {
          nextMcp[name] = raw
        }
      }
    }
    merged.mcpServers = nextMcp
  }
  for (const key of RESOURCE_KEYS) {
    const list = [...(base[key] ?? []), ...(override[key] ?? [])]
    if (list.length) merged[key] = list
  }
  const tools = mergeDefaultTools(base.tools, override.tools)
  if (tools !== undefined) merged.tools = tools
  return merged
}

/** Build the per-extension config map (`vela.config`) from flattened top-level sections + custom `extensionConfig`. */
export function toExtensionConfigView(
  settings: VelaSettings,
): Record<string, Record<string, unknown>> {
  const view: Record<string, Record<string, unknown>> = {}
  if (settings.extensionConfig) {
    for (const [name, section] of Object.entries(settings.extensionConfig))
      view[name] = { ...section }
  }
  if (settings.lark) view.lark = { ...settings.lark }
  if (settings.web) view.web = { ...settings.web }
  if (settings.memory) view.memory = { ...settings.memory }
  if (settings.local) view.local = { ...settings.local }
  if (settings.webhooks)
    view.channel = { ...(view.channel ?? {}), eventReceiver: settings.webhooks }
  return view
}
