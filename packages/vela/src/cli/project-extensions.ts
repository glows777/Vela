import { join, resolve } from 'node:path'
import { toExtensionConfigView } from '../config/index.ts'
import type { ChannelExtension } from '../legacy-channels/index.ts'
import {
  extensionName,
  importExtension,
  type VelaConfig,
} from '../load-config.ts'
import { mcpConfig } from '../mcp/index.ts'
import {
  BUILTIN_EXTENSIONS,
  type CliArgs,
  extensionConfigFromEnv,
  HOST_STORAGE_BUILTINS,
  SESSION_BUILTINS,
  withMcpServers,
} from './setup.ts'

type Split = NonNullable<VelaConfig['sessionResources']>
type ProjectLoader = NonNullable<Split['projectExtensions']>

function explicitNames(args: CliArgs): Set<string> {
  return new Set(
    args.extensions.map(
      (source) =>
        /^builtin:(.+)$/.exec(source)?.[1] ?? extensionName(resolve(source)),
    ),
  )
}

/** Resolve the immutable configuration before the core chooses a shared scope. */
export function cliProjectExtensions(
  config: VelaConfig,
  args: CliArgs,
  onDiagnostic: (message: string) => void = () => {},
) {
  const explicit = explicitNames(args)
  const split = config.sessionResources!
  return async ({
    cwd,
    environmentId,
    trusted,
    settings,
    projectSettings,
    entries,
  }: Parameters<ProjectLoader>[0]) => {
    if (args.noExtensions)
      return { key: 'disabled', extensionConfig: {}, load: async () => [] }
    const local = environmentId === 'node:local'
    if (!local)
      onDiagnostic(
        `[extensions] Skipped project extensions and MCP for unsupported environment ${environmentId}:${cwd}`,
      )
    const hostNames = new Set(
      (split.hostExtensions ?? [])
        .filter((entry) => !('builtin' in entry))
        .map((entry) => entry.name),
    )
    for (const name of Object.keys(toExtensionConfigView(projectSettings))) {
      if (
        HOST_STORAGE_BUILTINS.has(name) ||
        (hostNames.has(name) && !explicit.has(name))
      )
        onDiagnostic(
          `[extensions] ${cwd}: project configuration for host extension "${name}" is ignored; configure it in the user settings instead`,
        )
      if (
        name === 'lark' &&
        cwd !== config.cwd &&
        JSON.stringify(settings.lark) !==
          JSON.stringify(config.extensionConfig.lark)
      )
        onDiagnostic(
          `[extensions] ${cwd}: project lark configuration is ignored; the listener belongs to the host started at ${config.cwd}`,
        )
    }
    if (
      cwd !== config.cwd &&
      (projectSettings.extensions ?? []).some((entry) =>
        /^[+]?builtin:lark$/.test(entry),
      )
    )
      onDiagnostic(
        `[extensions] ${cwd}: project activation of builtin:lark is ignored; listeners are host-owned`,
      )
    const builtins = split.extensionBuiltins
    const disabled = new Set(builtins?.defaultOff ?? [])
    for (const entry of settings.extensions ?? []) {
      const match = /^([+-]?)builtin:(.+)$/.exec(entry)
      if (!match) continue
      if (!(builtins?.names ?? []).includes(match[2]!))
        throw new Error(`Unknown built-in extension builtin:${match[2]}`)
      if (match[1] === '-') disabled.add(match[2]!)
      else disabled.delete(match[2]!)
    }
    const names = (builtins?.names ?? []).filter(
      (name) =>
        !disabled.has(name) &&
        SESSION_BUILTINS.has(name) &&
        (local || name !== 'mcp') &&
        !explicit.has(name),
    )
    const extensionConfig = extensionConfigFromEnv(
      split.env ?? {},
      toExtensionConfigView(settings),
    )
    for (const name of HOST_STORAGE_BUILTINS) delete extensionConfig[name]
    if (!local) delete extensionConfig.mcp
    if (names.includes('mcp'))
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
    const selected = (local && trusted ? entries : []).filter(
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
        const loaded: ChannelExtension[] = names.map((name) =>
          BUILTIN_EXTENSIONS[name]!(settings),
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

/** Only the owner can bind a group to an environment. Keep the normal merged chat options. */
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
  if (Array.isArray(trusted))
    for (const row of trusted)
      if (
        row &&
        typeof row.id === 'string' &&
        Object.hasOwn(row, 'environment')
      )
        selected.set(row.id.trim(), row.environment)
  if (!selected.size && typeof chats === 'string') return chats
  const merged = rows(chats)
  if (!Array.isArray(merged)) return chats
  return merged.map((row) => {
    const id = typeof row === 'string' ? row.trim() : row?.id?.trim?.()
    if (selected.has(id))
      return {
        ...(typeof row === 'string' ? { id } : row),
        environment: selected.get(id),
      }
    if (row && typeof row === 'object' && Object.hasOwn(row, 'environment')) {
      const { environment: _, ...rest } = row
      return rest
    }
    return row
  })
}

/** Host singletons consume user config, except explicit factories and host-owned listeners. */
export function cliHostExtensionConfig(config: VelaConfig, args: CliArgs) {
  const sections = { ...config.userExtensionConfig }
  for (const name of new Set(['lark', ...explicitNames(args)])) {
    if (HOST_STORAGE_BUILTINS.has(name)) continue
    const section = config.extensionConfig[name]
    if (section)
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
  const resolved = extensionConfigFromEnv(
    config.sessionResources?.env ?? {},
    sections,
  )
  return explicitNames(args).has('mcp')
    ? withMcpServers(resolved, config)
    : resolved
}
