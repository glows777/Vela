import { join, resolve } from 'node:path'
import type { CliArgs } from '../../packages/vela/src/cli/setup.ts'
import { resolveShellPath } from '../../packages/vela/src/cli/shell.ts'
import {
  toExtensionConfigView,
  type VelaSettings,
} from '../../packages/vela/src/config/index.ts'
import { savedTrust } from '../../packages/vela/src/db/index.ts'
import { canonicalLocalPath } from '../../packages/vela/src/db/trust.ts'
import {
  background,
  memory,
  todo,
  web,
  webConfig,
} from '../../packages/vela/src/driver/index.ts'
import { lark, larkConfig } from '../../packages/vela/src/lark/index.ts'
import type { ChannelExtension as VelaExtension } from '../../packages/vela/src/legacy-channels/index.ts'
import {
  type ExtensionEntry,
  extensionName,
  importExtension,
  type VelaConfig,
} from '../../packages/vela/src/load-config.ts'
import { McpPool, mcp, mcpConfig } from '../../packages/vela/src/mcp/index.ts'
import { EnvironmentRegistry } from '../../packages/vela/src/runtime/index.ts'

export const BUILTIN_EXTENSIONS: Record<
  string,
  (settings: VelaSettings, options?: { mcpPool?: McpPool }) => VelaExtension
> = {
  background: (settings) =>
    background({ shellPath: resolveShellPath(settings.shellPath) }),
  memory: () => memory(),
  web: () => web(),
  lark: () => lark(),
  mcp: (_settings, options) =>
    mcp(options?.mcpPool ? { pool: options.mcpPool } : {}),
  todo: () => todo(),
}

const SESSION_BUILTINS = new Set(['background', 'web', 'mcp', 'todo'])
const HOST_STORAGE_BUILTINS = new Set(['memory'])

function explicitNames(args: CliArgs): Set<string> {
  return new Set(
    args.extensions.map(
      (source) =>
        /^builtin:(.+)$/.exec(source)?.[1] ?? extensionName(resolve(source)),
    ),
  )
}

function extensionConfigFromEnv(
  env: Record<string, string | undefined>,
  fromSettings: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const result = { ...fromSettings }
  const context = { cwd: '', agentDir: '', projectDir: '', trusted: false, env }
  for (const definition of [webConfig, larkConfig]) {
    result[definition.name] = definition.resolve(
      result[definition.name] ?? {},
      context,
    )
  }
  return result
}

function withMcpServers(
  extensionConfig: Record<string, Record<string, unknown>>,
  config: Pick<VelaConfig, 'mcp'>,
): Record<string, Record<string, unknown>> {
  const { servers, sources, errors } = config.mcp
  const section = extensionConfig.mcp ?? {}
  const fromSettings =
    typeof section.mcpServers === 'object' && section.mcpServers !== null
      ? (section.mcpServers as Record<string, unknown>)
      : {}
  return {
    ...extensionConfig,
    mcp: {
      ...section,
      mcpServers: { ...fromSettings, ...servers },
      sources,
      errors,
    },
  }
}

function ownerChatLocations(chats: unknown, owner: unknown) {
  const rows = (value: unknown) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      : value
  const trusted = rows(owner)
  const selected = new Map<string, unknown>()
  if (Array.isArray(trusted)) {
    for (const row of trusted) {
      if (
        row &&
        typeof row.id === 'string' &&
        Object.hasOwn(row, 'environment')
      ) {
        selected.set(row.id.trim(), row.environment)
      }
    }
  }
  if (!selected.size && typeof chats === 'string') return chats
  const merged = rows(chats)
  if (!Array.isArray(merged)) return chats
  return merged.map((row) => {
    const id = typeof row === 'string' ? row.trim() : row?.id?.trim?.()
    if (selected.has(id)) {
      return {
        ...(typeof row === 'string' ? { id } : row),
        environment: selected.get(id),
      }
    }
    if (row && typeof row === 'object' && Object.hasOwn(row, 'environment')) {
      const { environment: _, ...rest } = row
      return rest
    }
    return row
  })
}

export function cliHostExtensionConfig(config: VelaConfig, args: CliArgs) {
  const sections = { ...config.userExtensionConfig }
  for (const name of new Set(['lark', ...explicitNames(args)])) {
    if (HOST_STORAGE_BUILTINS.has(name)) continue
    const section = config.extensionConfig[name]
    if (section) {
      sections[name] =
        name === 'lark' && section.chats !== undefined
          ? {
              ...section,
              chats: ownerChatLocations(
                section.chats,
                config.userExtensionConfig.lark?.chats,
              ),
            }
          : section
    }
  }
  const resolved = extensionConfigFromEnv(
    config.sessionResources?.env ?? {},
    sections,
  )
  return explicitNames(args).has('mcp')
    ? withMcpServers(resolved, config)
    : resolved
}

export function cliProjectExtensions(
  config: VelaConfig,
  args: CliArgs,
  onDiagnostic: (message: string) => void = () => {},
  mcpPool: McpPool = new McpPool({ idleTtlMs: 0 }),
) {
  const explicit = explicitNames(args)
  const split = config.sessionResources!
  return async (input: {
    cwd: string
    environmentId?: string
    trusted: boolean
    settings: VelaSettings
    projectSettings?: VelaSettings
    entries: ExtensionEntry[]
  }) => {
    if (args.noExtensions) {
      return { key: 'disabled', extensionConfig: {}, load: async () => [] }
    }
    const { cwd, environmentId, trusted, settings, projectSettings, entries } =
      input
    const localEnv = environmentId === 'node:local'
    if (!localEnv) {
      onDiagnostic(
        `[extensions] Skipped project extensions and MCP for unsupported environment ${environmentId}:${cwd}`,
      )
    }
    const hostNames = new Set(
      (split.hostExtensions ?? [])
        .filter((entry) => !('builtin' in entry))
        .map((entry) => entry.name),
    )
    if (projectSettings) {
      for (const name of Object.keys(toExtensionConfigView(projectSettings))) {
        if (
          HOST_STORAGE_BUILTINS.has(name) ||
          (hostNames.has(name) && !explicit.has(name))
        ) {
          onDiagnostic(
            `[extensions] ${cwd}: project configuration for host extension "${name}" is ignored; configure it in the user settings instead`,
          )
        }
        if (
          name === 'lark' &&
          cwd !== config.cwd &&
          JSON.stringify(settings.lark) !==
            JSON.stringify(config.extensionConfig.lark)
        ) {
          onDiagnostic(
            `[extensions] ${cwd}: project lark configuration is ignored; the listener belongs to the host started at ${config.cwd}`,
          )
        }
      }
    }
    if (
      cwd !== config.cwd &&
      (projectSettings?.extensions ?? []).some((entry) =>
        /^[+]?builtin:lark$/.test(entry),
      )
    ) {
      onDiagnostic(
        `[extensions] ${cwd}: project activation of builtin:lark is ignored; listeners are host-owned`,
      )
    }
    const builtins = split.extensionBuiltins
    const disabled = new Set(builtins?.defaultOff ?? [])
    for (const entry of settings.extensions ?? []) {
      const match = /^([+-]?)builtin:(.+)$/.exec(entry)
      if (!match) continue
      if (!(builtins?.names ?? []).includes(match[2]!)) {
        if (match[1] === '-' && match[2] === 'rag') continue
        throw new Error(`Unknown built-in extension builtin:${match[2]}`)
      }
      if (match[1] === '-') disabled.add(match[2]!)
      else disabled.delete(match[2]!)
    }
    const names = (builtins?.names ?? []).filter(
      (name) =>
        !disabled.has(name) &&
        SESSION_BUILTINS.has(name) &&
        (localEnv || name !== 'mcp') &&
        !explicit.has(name),
    )
    const extensionConfig = extensionConfigFromEnv(
      split.env ?? {},
      toExtensionConfigView(settings),
    )
    for (const name of HOST_STORAGE_BUILTINS) delete extensionConfig[name]
    if (!localEnv) delete extensionConfig.mcp
    if (names.includes('mcp')) {
      extensionConfig.mcp = mcpConfig.resolve(
        {},
        {
          cwd,
          agentDir: split.agentDir,
          projectDir: join(cwd, '.vela'),
          trusted: trusted && join(cwd, '.vela') !== split.agentDir,
          env: split.env ?? {},
        },
      )
    }
    const selected = (localEnv && trusted ? entries : []).filter(
      (entry) => !explicit.has(entry.name),
    )
    return {
      key: JSON.stringify({
        names,
        entries: selected,
        extensionConfig,
        shellPath: settings.shellPath,
      }),
      extensionConfig,
      load: async () => {
        const loaded: VelaExtension[] = names.map((name) =>
          BUILTIN_EXTENSIONS[name]!(settings, { mcpPool }),
        )
        for (const entry of selected) {
          if ('builtin' in entry) continue
          loaded.push(await importExtension(entry.path, entry.name))
        }
        return loaded
      },
    }
  }
}

export async function loadCliExtensions(
  config: VelaConfig,
  args: CliArgs,
  onError: (message: string) => void,
  hostOnly = false,
  mcpPool?: McpPool,
): Promise<VelaExtension[]> {
  const split = config.sessionResources
  const explicit = explicitNames(args)
  const entries = [
    ...(args.noExtensions
      ? []
      : hostOnly
        ? [
            ...config.extensions.filter(
              (entry) =>
                'builtin' in entry &&
                !SESSION_BUILTINS.has(entry.name) &&
                !HOST_STORAGE_BUILTINS.has(entry.name) &&
                !explicit.has(entry.name),
            ),
            ...(split?.hostExtensions ?? config.extensions).filter(
              (entry) =>
                !('builtin' in entry) || HOST_STORAGE_BUILTINS.has(entry.name),
            ),
          ]
        : config.extensions),
    ...args.extensions.map((source): ExtensionEntry => {
      const builtin = /^builtin:(.+)$/.exec(source)?.[1]
      if (builtin) return { name: builtin, builtin: true }
      const p = resolve(source)
      return { name: extensionName(p), path: p }
    }),
  ]
  const out: VelaExtension[] = []
  for (const entry of entries) {
    try {
      if ('builtin' in entry) {
        const f = BUILTIN_EXTENSIONS[entry.name]
        if (!f)
          throw new Error(`Unknown built-in extension builtin:${entry.name}`)
        out.push(f(config.settings, mcpPool ? { mcpPool } : undefined))
      } else {
        out.push(await importExtension(entry.path, entry.name))
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }
  return out
}

export function ownerDocker(config: Pick<VelaConfig, 'dataDir' | 'settings'>) {
  const environments = config.settings.environments
  if (!environments || Object.keys(environments).length === 0) return undefined
  const registry = new EnvironmentRegistry({
    dataDir: config.dataDir,
    environments,
    hostEnv: process.env,
  })
  return {
    environments: registry,
    env: ({
      sessionId,
      location,
    }: {
      sessionId: string
      location: { environment: string; cwd: string }
    }) => registry.resolve({ sessionId, location }),
    beforeDispose: () => registry.dispose(),
  }
}

export function cliWorkspaceModeAt(options: {
  agentDir: string
  dataDir?: string
  startupCwd: string
  approve?: boolean
  location: string
  environment?: string
}): 'home' | 'all' | 'none' {
  const { agentDir, dataDir, startupCwd, approve, location } = options
  const environment = options.environment ?? 'local'
  if (environment === 'local') {
    const canonicalLoc = canonicalLocalPath(location)
    const canonicalStartup = canonicalLocalPath(startupCwd)
    const canonicalAgentDir = canonicalLocalPath(agentDir)
    if (canonicalLocalPath(join(canonicalLoc, '.vela')) === canonicalAgentDir) {
      return 'home'
    }
    if (canonicalLoc === canonicalStartup) {
      return approve === true ||
        (approve !== false && savedTrust(agentDir, canonicalLoc) === true)
        ? 'all'
        : 'none'
    }
    return approve !== false && savedTrust(agentDir, canonicalLoc) === true
      ? 'all'
      : 'none'
  }
  return approve !== false &&
    savedTrust(agentDir, { environment, cwd: location }, dataDir) === true
    ? 'all'
    : 'none'
}
