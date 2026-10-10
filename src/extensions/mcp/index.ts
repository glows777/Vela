/**
 * The built-in MCP extension (like pi's `extensions/mcp`): connects to MCP servers over stdio or
 * streamable HTTP and registers their tools as `mcp__<server>__<tool>`, deferred by default so
 * tool_search loads them on demand.
 *
 * Unlike pi, one set of connections serves all sessions of a Vela (a Feishu bot has many concurrent
 * sessions); they start with the first session and close when the Vela is disposed.
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ExtensionContext, VelaExtension } from '../types.ts'
import {
  type McpServerConfig,
  type McpServerEntry,
  parseServers,
  toolExposureOf,
} from './config.ts'
import { McpConnection } from './connection.ts'
import { createMcpTool, createMcpToolName, namespaceName } from './tools.ts'

export type {
  McpExposure,
  McpHttpServerConfig,
  McpServerConfig,
  McpServersFile,
  McpStdioServerConfig,
} from './config.ts'

/** The first prompt waits this long for servers with direct tools (like pi). */
const DIRECT_WAIT_MS = 10_000

export interface McpOptions {
  /**
   * Servers in the `mcpServers` format of Claude Desktop / Claude Code (`{ name: { command, args } }`
   * or `{ name: { url, headers } }`). Default: `mcpServers` in this extension's config, which the
   * CLI fills from `~/.vela/mcp.json` and the trusted project's `.vela/mcp.json`.
   */
  servers?: Record<string, McpServerConfig>
  /** @internal Creates transports (tests use in-memory servers) */
  createTransport?: (entry: McpServerEntry, cwd: string) => Promise<Transport>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The built-in MCP extension. Its tools are `mcp__<server>__<tool>`; guests can't use them. */
export function mcp(options: McpOptions = {}): VelaExtension {
  return function mcp(vela) {
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
    // Errors found while reading mcp.json (bad JSON, unset variables)
    if (!options.servers && Array.isArray(vela.config.errors))
      errors.unshift(...vela.config.errors.map(String))

    const connections = new Map<string, McpConnection>()
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

    for (const entry of entries) {
      if (entry.config.enabled === false) continue
      connections.set(
        entry.name,
        new McpConnection({
          entry,
          cwd: vela.cwd,
          onTools: syncTools,
          ...(options.createTransport
            ? { createTransport: options.createTransport }
            : {}),
        }),
      )
    }

    /** Settles when every server has connected or failed (started on the first session_start). */
    let started: Promise<void> | undefined
    /** Settles when the servers that declare direct tools have connected or failed. */
    let directReady: Promise<void> = Promise.resolve()

    const start = (ctx: ExtensionContext) => {
      if (started) return
      const attempts = [...connections.values()].map((connection) => ({
        connection,
        done: connection.connect().then(
          () => undefined,
          (error: unknown) =>
            error instanceof Error ? error.message : String(error),
        ),
      }))
      directReady = Promise.all(
        attempts
          .filter(({ connection }) => hasDirectTools(connection.entry))
          .map(({ done }) => done),
      ).then(() => {})
      const report = (problems: string[]) => {
        if (problems.length === 0) return
        const message = `[mcp] ${problems.join('\n[mcp] ')}\nRun /mcp for details.`
        if (ctx.hasUI) ctx.ui.notify(message, 'error')
        else vela.logger.error(message)
      }
      // Report configuration errors now and failed connections once they settle (like pi)
      report(errors)
      started = Promise.all(attempts.map(({ done }) => done)).then((failures) =>
        report(failures.filter((f): f is string => f !== undefined)),
      )
    }

    vela.on('session_start', (_event, ctx) => {
      if (connections.size === 0 && errors.length === 0) return
      start(ctx)
    })

    // The first prompt waits (up to 10s) only for servers with direct tools, which must be declared
    // in its request; deferred tools are waited for by tool_search (like pi)
    vela.on('before_agent_start', async (event, ctx) => {
      // Guests can't use MCP tools, so they neither wait for servers nor see their names
      if (!started || ctx.session.role === 'guest') return
      // Servers still connecting are listed by name, so the model knows to search for their tools
      // (like pi's mcp_servers section); connected servers appear in the deferred tool list
      const pending = [...connections.values()].filter(
        (c) =>
          (c.state === 'connecting' || c.state === 'idle') &&
          c.entry.config.exposure !== 'hidden',
      )
      if (pending.length)
        event.sections.mcp_servers = [
          'MCP servers still connecting (tool_search waits for them and finds their tools):',
          ...pending.map(
            (c) =>
              `- ${namespaceName(c.name)}${c.entry.config.description ? ` — ${c.entry.config.description}` : ''}`,
          ),
        ].join('\n')
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        directReady,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, DIRECT_WAIT_MS)
        }),
      ])
      clearTimeout(timer)
    })

    vela.on('tool_call', async (event) => {
      if (event.toolName === 'tool_search' && started) await started
    })

    vela.registerCommand('mcp', {
      description:
        'Show MCP servers and their tools; /mcp reconnect <server> to reconnect one',
      handler: async (args, ctx) => {
        const [action, server] = args.split(/\s+/)
        if (action === 'reconnect') {
          const connection = server ? connections.get(server) : undefined
          if (!connection)
            return ctx.ui.notify(
              `Unknown MCP server "${server ?? ''}". Servers: ${[...connections.keys()].join(', ') || 'none'}`,
              'error',
            )
          try {
            await connection.reconnect()
            ctx.ui.notify(
              `MCP server "${connection.name}" connected (${connection.tools.length} tools)`,
            )
          } catch (error) {
            ctx.ui.notify(
              error instanceof Error ? error.message : String(error),
              'error',
            )
          }
          return
        }
        if (action) return ctx.ui.notify('Usage: /mcp [reconnect <server>]')
        ctx.ui.notify(statusReport(entries, connections, registered, errors))
      },
    })

    vela.onShutdown(async () => {
      await Promise.all([...connections.values()].map((c) => c.close()))
    })
  }
}

/** Whether any of the server's tools may have `direct` exposure. */
function hasDirectTools(entry: McpServerEntry): boolean {
  const { config } = entry
  return (
    config.exposure === 'direct' ||
    Object.values(config.toolExposure ?? {}).includes('direct')
  )
}

function statusReport(
  entries: McpServerEntry[],
  connections: Map<string, McpConnection>,
  registered: Map<string, string[]>,
  errors: string[],
): string {
  if (entries.length === 0 && errors.length === 0)
    return 'No MCP servers configured. Add them to ~/.vela/mcp.json or .vela/mcp.json (see docs/mcp.md).'
  const lines: string[] = ['MCP servers:']
  for (const entry of entries) {
    const connection = connections.get(entry.name)
    const state = connection ? connection.state : 'disabled'
    const tools = registered.get(entry.name)?.length ?? 0
    lines.push(
      `- ${entry.name}: ${state}, ${tools} tool${tools === 1 ? '' : 's'}, exposure ${entry.config.exposure ?? 'deferred'} (${entry.source})`,
    )
    if (connection?.error)
      lines.push(`  ${connection.error.replaceAll('\n', '\n  ')}`)
  }
  for (const error of errors) lines.push(`- error: ${error}`)
  return lines.join('\n')
}
