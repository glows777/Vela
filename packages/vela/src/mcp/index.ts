/**
 * The built-in MCP extension (like pi's `extensions/mcp`): connects to MCP servers over stdio or
 * streamable HTTP and registers their tools as `mcp__<server>__<tool>`, deferred by default so
 * tool_search loads them on demand.
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { VelaExtension } from '../extension-api.ts'
import {
  type McpServerConfig,
  type McpServerEntry,
  parseServers,
  toolExposureOf,
} from './config.ts'
import type { McpConnection } from './connection.ts'
import { McpPool } from './pool.ts'
import { createMcpTool, createMcpToolName, namespaceName } from './tools.ts'

export type {
  McpExposure,
  McpHttpServerConfig,
  McpServerConfig,
  McpServersFile,
  McpStdioServerConfig,
} from './config.ts'
export { McpPool } from './pool.ts'

/** The first prompt waits this long for servers with direct tools (like pi). */
const DIRECT_WAIT_MS = 10_000

export interface McpOptions {
  /**
   * Servers in the `mcpServers` format of Claude Desktop / Claude Code (`{ name: { command, args } }`
   * or `{ name: { url, headers } }`). Default: `mcpServers` in this extension's config, which the
   * CLI fills from `~/.vela/config.json` and the trusted project's `.vela/config.json`.
   */
  servers?: Record<string, McpServerConfig>
  /** @internal Creates transports (tests use in-memory servers) */
  createTransport?: (entry: McpServerEntry, cwd: string) => Promise<Transport>
  /** @internal Shared connection pool keyed by `(cwd, mcpServers)` */
  pool?: McpPool
  /** @internal Idle eviction delay (ms) when creating an extension-owned pool */
  idleTtlMs?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The built-in MCP extension. Its tools are `mcp__<server>__<tool>`. */
export function mcp(options: McpOptions = {}): VelaExtension {
  const extension: VelaExtension = (vela) => {
    const fromConfig = isRecord(vela.config.mcpServers)
      ? vela.config.mcpServers
      : {}
    const sources = isRecord(vela.config.sources)
      ? (vela.config.sources as Record<string, string>)
      : {}
    const { entries, errors } = parseServers(
      options.servers ?? fromConfig,
      options.servers ? {} : sources,
    )
    // Errors found while reading config.json mcpServers (bad JSON, unset variables)
    if (!options.servers && Array.isArray(vela.config.errors))
      errors.unshift(...vela.config.errors.map(String))

    // Declare static namespace lines synchronously so <deferred_tools> stays cache-invariant
    // whether deferred servers connect before or after turn 1.
    for (const entry of entries) {
      if (entry.config.enabled === false) continue
      const mayDefer =
        (entry.config.exposure ?? 'deferred') === 'deferred' ||
        Object.values(entry.config.toolExposure ?? {}).includes('deferred')
      if (!mayDefer) continue
      const ns = namespaceName(entry.name)
      vela.registerDeferredNamespace?.(
        ns,
        `- ${ns}${entry.config.description ? ` — ${entry.config.description}` : ''}`,
      )
    }

    /** Server → its registered tool names */
    const registered = new Map<string, string[]>()
    /** Registered MCP tool name → `<server>\0<tool>`, to detect sanitized names that collide */
    const owners = new Map<string, string>()

    const syncTools = (connection: McpConnection) => {
      const { name: server, config } = connection.entry
      for (const toolName of registered.get(server) ?? []) {
        vela.unregisterTool(toolName)
        owners.delete(toolName)
      }
      const names: string[] = []
      const namespace = {
        name: namespaceName(server),
        description:
          config.description ?? connection.instructions?.split('\n')[0],
        ...(connection.instructions
          ? { instructions: connection.instructions }
          : {}),
      }
      for (const tool of connection.tools) {
        const owner = `${server}\0${tool.name}`
        const name = createMcpToolName(server, tool.name, (candidate) => {
          const existing = owners.get(candidate)
          return existing !== undefined && existing !== owner
        })
        try {
          vela.registerTool(
            createMcpTool({
              server,
              tool,
              name,
              exposure: toolExposureOf(config, tool.name),
              namespace,
              caller: connection,
            }),
          )
          names.push(name)
          owners.set(name, owner)
        } catch (error) {
          vela.logger.error(
            `[mcp] ${server}: could not register ${tool.name}: ${error instanceof Error ? error.message : error}`,
          )
        }
      }
      registered.set(server, names)
    }

    const ownsPool = !options.pool
    const pool =
      options.pool ?? new McpPool({ idleTtlMs: options.idleTtlMs ?? 0 })
    const reporters = new Map<string, (message: string) => void>()
    const report = (problems: string[]) => {
      if (problems.length === 0) return
      const message = `[mcp] ${problems.join('\n[mcp] ')}\nRun /mcp for details.`
      for (const notify of reporters.values()) notify(message)
      vela.logger.error(message)
    }

    const lease = pool.acquire({
      cwd: vela.cwd,
      entries,
      errors,
      ...(options.createTransport
        ? { createTransport: options.createTransport }
        : {}),
      onTools: syncTools,
      onError: report,
    })

    vela.on('session_start', (_event, ctx) => {
      if (!lease.hasWork) return
      reporters.set(ctx.session.id, (message) => ctx.notify(message, 'error'))
      lease.start()
    })

    vela.on('session_shutdown', (_event, ctx) => {
      reporters.delete(ctx.session.id)
    })

    // The first prompt waits (up to 10s) for servers with direct tools and any server owning
    // previously restored discoveredTools, while deferred namespaces stay static in <deferred_tools>.
    const namespacePrefixes = new Map<string, string[]>()
    for (const entry of entries) {
      if (entry.config.enabled === false) continue
      const prefix = `${namespaceName(entry.name)}__`
      const list = namespacePrefixes.get(prefix) ?? []
      list.push(entry.name)
      namespacePrefixes.set(prefix, list)
    }
    vela.on('before_agent_start', async (event) => {
      const extraServers = new Set<string>()
      for (const toolName of event.discoveredTools ?? []) {
        for (const [prefix, serverNames] of namespacePrefixes) {
          if (toolName.startsWith(prefix)) {
            for (const name of serverNames) extraServers.add(name)
          }
        }
      }
      await lease.waitForDirect(
        DIRECT_WAIT_MS,
        extraServers.size > 0 ? extraServers : undefined,
      )
    })

    vela.on('tool_call', 'tool_search', async () => {
      // tool_search waits for servers that are still connecting, so it can find their tools
      await lease.waitForAll()
    })

    vela.registerCommand('mcp', {
      description:
        'Show MCP servers and their tools; /mcp reconnect <server> to reconnect one',
      handler: async (args, ctx) => {
        const [action, server] = args.split(/\s+/)
        if (action === 'reconnect') {
          const result = await lease.reconnect(server)
          if (!result.ok) {
            if (result.kind === 'unknown')
              return ctx.notify(
                `Unknown MCP server "${server ?? ''}". Servers: ${result.available.join(', ') || 'none'}`,
                'error',
              )
            return ctx.notify(result.message, 'error')
          }
          return ctx.notify(
            `MCP server "${result.connection.name}" connected (${result.connection.tools.length} tools)`,
          )
        }
        if (action) return ctx.notify('Usage: /mcp [reconnect <server>]')
        ctx.notify(lease.status(registered))
      },
    })

    vela.onShutdown(async () => {
      reporters.clear()
      await lease.release()
      if (ownsPool) await pool.dispose()
    })
  }
  return Object.defineProperty(extension, 'name', { value: 'mcp' })
}

export { mcpConfig } from './config.ts'
