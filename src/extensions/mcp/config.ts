/**
 * MCP server configuration (like pi's `extensions/mcp/config.ts`): the `mcpServers` format of
 * Claude Desktop / Claude Code, read from `~/.vela/mcp.json` and the trusted project's
 * `.vela/mcp.json`. Invalid entries are reported and skipped; they don't stop other servers.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isPlainObject } from '../../config/interpolate.ts'

/**
 * How the model reaches a server's tools. Vela has no codemode yet, so `codemode` (pi's default) is
 * rejected; `deferred` is the default until it exists.
 */
export type McpExposure = 'direct' | 'deferred' | 'hidden'

const EXPOSURES: readonly McpExposure[] = ['direct', 'deferred', 'hidden']

interface McpCommonConfig {
  /** Per-request timeout in seconds (default 60); progress notifications reset it */
  timeout?: number
  /** `false` keeps the entry without connecting */
  enabled?: boolean
  /** Exposure of the server's tools (default `deferred`) */
  exposure?: McpExposure
  /** Per-tool exposure: exact tool names or `*` patterns; exact names win, then the first matching pattern */
  toolExposure?: Record<string, McpExposure>
  /** What the server offers, in a sentence; listed in the system prompt (default: first line of the server instructions) */
  description?: string
}

/** A local server started as a child process. */
export interface McpStdioServerConfig extends McpCommonConfig {
  type?: 'stdio'
  /** One executable (not a shell command line); `~/` names the home directory */
  command: string
  args?: string[]
  env?: Record<string, string>
  /** Working directory, relative to the Vela's cwd */
  cwd?: string
}

/** A remote server over Streamable HTTP. */
export interface McpHttpServerConfig extends McpCommonConfig {
  type?: 'http' | 'streamable-http'
  url: string
  headers?: Record<string, string>
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig

/** A validated server. */
export interface McpServerEntry {
  name: string
  config: McpServerConfig
  /** Where it was configured (a file path, or `options` for `mcp({ servers })`) */
  source: string
}

/** Server names: letters, digits, `_` and `-` (like pi). */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/

const stringRecord = (value: unknown): value is Record<string, string> =>
  isPlainObject(value) &&
  Object.values(value).every((item) => typeof item === 'string')

/** Validates one `mcpServers` entry; throws a message naming the problem. */
export function parseServerConfig(name: string, raw: unknown): McpServerConfig {
  const fail = (message: string): never => {
    throw new Error(`MCP server "${name}": ${message}`)
  }
  if (!SERVER_NAME.test(name))
    fail('names may contain only letters, digits, "_" and "-"')
  if (!isPlainObject(raw)) return fail('must be an object')
  const { type } = raw
  if (type === 'sse' || (type === undefined && raw.transport === 'sse'))
    fail(
      'the legacy SSE transport is not supported; use the streamable HTTP endpoint (often /mcp instead of /sse)',
    )
  if (
    type !== undefined &&
    type !== 'stdio' &&
    type !== 'http' &&
    type !== 'streamable-http'
  )
    fail(`type must be "stdio", "http" or "streamable-http"`)
  if (raw.timeout !== undefined) {
    if (typeof raw.timeout !== 'number' || !(raw.timeout > 0))
      fail('timeout must be a positive number of seconds')
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean')
    fail('enabled must be true or false')
  if (raw.description !== undefined && typeof raw.description !== 'string')
    fail('description must be a string')
  const exposure = (value: unknown, where: string) => {
    if (value === 'codemode' || value === 'codemode-deferred')
      fail(
        `${where} "${value}" is not available: Vela has no codemode yet. Use "deferred" (tool_search loads the tools) or "direct"`,
      )
    if (!EXPOSURES.includes(value as McpExposure))
      fail(`${where} must be one of ${EXPOSURES.join(', ')}`)
  }
  if (raw.exposure !== undefined) exposure(raw.exposure, 'exposure')
  if (raw.toolExposure !== undefined) {
    if (!isPlainObject(raw.toolExposure))
      fail('toolExposure must be an object of tool name → exposure')
    for (const [tool, value] of Object.entries(
      raw.toolExposure as Record<string, unknown>,
    ))
      exposure(value, `toolExposure["${tool}"]`)
  }

  const isHttp =
    type === 'http' ||
    type === 'streamable-http' ||
    (type === undefined && raw.url !== undefined)
  if (isHttp) {
    if (typeof raw.url !== 'string' || !URL.canParse(raw.url))
      fail('url must be a valid URL')
    if (raw.headers !== undefined && !stringRecord(raw.headers))
      fail('headers must be an object of strings')
    if (raw.command !== undefined)
      fail('set either command (stdio) or url (HTTP), not both')
  } else {
    if (typeof raw.command !== 'string' || raw.command.trim() === '')
      fail('needs a command (stdio) or a url (HTTP)')
    if (
      raw.args !== undefined &&
      !(
        Array.isArray(raw.args) &&
        raw.args.every((arg) => typeof arg === 'string')
      )
    )
      fail('args must be an array of strings')
    if (raw.env !== undefined && !stringRecord(raw.env))
      fail('env must be an object of strings')
    if (raw.cwd !== undefined && typeof raw.cwd !== 'string')
      fail('cwd must be a string')
  }
  return raw as unknown as McpServerConfig
}

/**
 * Validates `mcpServers`. Server names that differ only in `-` and `_` count as the same server
 * (their tool names would be the same); the second one is an error.
 */
export function parseServers(
  servers: Record<string, unknown>,
  sources: Record<string, string> = {},
): { entries: McpServerEntry[]; errors: string[] } {
  const entries: McpServerEntry[] = []
  const errors: string[] = []
  const keys = new Map<string, string>()
  for (const [name, raw] of Object.entries(servers)) {
    try {
      const config = parseServerConfig(name, raw)
      const key = name.replaceAll('-', '_')
      const clash = keys.get(key)
      if (clash)
        throw new Error(
          `MCP server "${name}": clashes with "${clash}" (names differing only in "-" and "_" are the same server)`,
        )
      keys.set(key, name)
      entries.push({ name, config, source: sources[name] ?? 'options' })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return { entries, errors }
}

/** The exposure of one of the server's tools: exact `toolExposure` names, then the first matching pattern, then the server's. */
export function toolExposureOf(
  config: McpServerConfig,
  tool: string,
): McpExposure {
  const overrides = config.toolExposure ?? {}
  const exact = overrides[tool]
  if (exact) return exact
  for (const [pattern, exposure] of Object.entries(overrides)) {
    if (!pattern.includes('*')) continue
    const regex = new RegExp(
      `^${pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    )
    if (regex.test(tool)) return exposure
  }
  return config.exposure ?? 'deferred'
}

/** Keys a project entry without `command`, `url` or `type` overrides on the user entry of the same name (like pi). */
const OVERRIDE_KEYS = ['enabled', 'exposure', 'toolExposure'] as const

/** Raw servers from the mcp.json files, merged, and where each came from. */
export interface McpServersFile {
  servers: Record<string, unknown>
  sources: Record<string, string>
  /** Unreadable files and unset variables */
  errors: string[]
}

type Env = Record<string, string | undefined>

/** `${NAME}` / `$NAME` in env and header values; unlike settings.json, an unset variable is an error (the server would fail anyway). */
function interpolateStrict(value: string, env: Env, where: string): string {
  return value.replace(
    /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced?: string, bare?: string) => {
      if (match === '$$') return '$'
      const name = (braced ?? bare) as string
      const resolved = env[name]
      if (resolved === undefined)
        throw new Error(`${where} uses \${${name}}, which is not set`)
      return resolved
    },
  )
}

function interpolateServer(
  name: string,
  raw: unknown,
  env: Env,
): Record<string, unknown> {
  if (!isPlainObject(raw)) return raw as Record<string, unknown>
  const result: Record<string, unknown> = { ...raw }
  for (const key of ['env', 'headers'] as const) {
    const values = raw[key]
    if (!stringRecord(values)) continue
    result[key] = Object.fromEntries(
      Object.entries(values).map(([k, v]) => [
        k,
        interpolateStrict(v, env, `MCP server "${name}" ${key} "${k}"`),
      ]),
    )
  }
  for (const key of ['url', 'command', 'cwd'] as const)
    if (typeof raw[key] === 'string')
      result[key] = interpolateStrict(
        raw[key] as string,
        env,
        `MCP server "${name}" ${key}`,
      )
  if (Array.isArray(raw.args))
    result.args = raw.args.map((arg) =>
      typeof arg === 'string'
        ? interpolateStrict(arg, env, `MCP server "${name}" args`)
        : arg,
    )
  return result
}

/**
 * Reads `<agentDir>/mcp.json`, then `<cwd>/.vela/mcp.json` when the project is trusted (like pi). A
 * project entry replaces the user entry of the same name; one without `command`, `url` or `type`
 * only overrides its `enabled`, `exposure` and `toolExposure`. Variables are resolved from `env`.
 */
export function loadMcpServers(options: {
  agentDir: string
  projectDir: string
  trusted: boolean
  env: Env
}): McpServersFile {
  const result: McpServersFile = { servers: {}, sources: {}, errors: [] }
  const files = [join(options.agentDir, 'mcp.json')]
  if (options.trusted) files.push(join(options.projectDir, 'mcp.json'))
  for (const file of files) {
    if (!existsSync(file)) continue
    let servers: unknown
    try {
      servers = (
        JSON.parse(readFileSync(file, 'utf-8')) as { mcpServers?: unknown }
      ).mcpServers
      if (servers === undefined) continue
      if (!isPlainObject(servers))
        throw new Error('mcpServers must be an object')
    } catch (error) {
      result.errors.push(
        `${file}: ${error instanceof Error ? error.message : String(error)}`,
      )
      continue
    }
    for (const [name, raw] of Object.entries(servers)) {
      const existing = result.servers[name]
      let entry: unknown = raw
      if (
        isPlainObject(raw) &&
        isPlainObject(existing) &&
        raw.command === undefined &&
        raw.url === undefined &&
        raw.type === undefined
      ) {
        const overrides = Object.fromEntries(
          OVERRIDE_KEYS.filter((key) => key in raw).map((key) => [
            key,
            raw[key],
          ]),
        )
        entry = { ...existing, ...overrides }
      }
      try {
        result.servers[name] = interpolateServer(name, entry, options.env)
        result.sources[name] = file
      } catch (error) {
        delete result.servers[name]
        result.errors.push(
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }
  return result
}
