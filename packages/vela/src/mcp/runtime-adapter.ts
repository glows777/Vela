import { join } from 'node:path'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { VelaLogger } from '../driver/extension-api.ts'
import type {
  RuntimeMcpAdapter,
  RuntimeMcpLease,
} from '../driver/runtime-adapter.ts'
import {
  loadMcpServers,
  type McpServerEntry,
  parseServers,
  toolExposureOf,
} from './config.ts'
import type { McpConnection } from './connection.ts'
import { McpPool } from './pool.ts'
import { createMcpTool, createMcpToolName, namespaceName } from './tools.ts'

const DIRECT_WAIT_MS = 10_000

export interface CreateRuntimeMcpAdapterOptions {
  pool?: McpPool
  idleTtlMs?: number
  hostEnv?: Record<string, string | undefined>
  skipUserConfig?: boolean
  createTransport?: (entry: McpServerEntry, cwd: string) => Promise<Transport>
  logger?: VelaLogger
}

/**
 * Bridges `McpPool` into `VelaAgentDriver` without creating a `driver -> mcp` layer dependency.
 */
export function createRuntimeMcpAdapter(
  options: CreateRuntimeMcpAdapterOptions = {},
): RuntimeMcpAdapter {
  const ownsPool = !options.pool
  const pool =
    options.pool ??
    new McpPool(
      options.idleTtlMs !== undefined ? { idleTtlMs: options.idleTtlMs } : {},
    )

  return {
    async attach({
      registry,
      agentDir,
      cwd,
      environment,
      trusted,
      env,
      waitMs = DIRECT_WAIT_MS,
      discoveredTools = [],
      signal,
    }): Promise<RuntimeMcpLease> {
      if (environment !== 'local') {
        return {
          waitForAll: async () => {},
          release: async () => {},
        }
      }
      const mergedEnv = { ...(options.hostEnv ?? {}), ...(env ?? {}) }
      const loaded = loadMcpServers({
        agentDir,
        projectDir: join(cwd, '.vela'),
        trusted,
        env: mergedEnv,
        skipUserConfig: options.skipUserConfig,
      })
      const { entries, errors } = parseServers(loaded.servers, loaded.sources)
      errors.unshift(...loaded.errors)

      const registered = new Map<string, string[]>()
      const owners = new Map<string, string>()

      for (const entry of entries) {
        if (entry.config.enabled === false) continue
        const mayDefer =
          (entry.config.exposure ?? 'deferred') === 'deferred' ||
          Object.values(entry.config.toolExposure ?? {}).includes('deferred')
        if (!mayDefer) continue
        const ns = namespaceName(entry.name)
        registry.registerDeferredNamespace(
          ns,
          `- ${ns}${entry.config.description ? ` — ${entry.config.description}` : ''}`,
        )
      }

      const preservedDiscovered = new Set(discoveredTools)
      const syncTools = (connection: McpConnection) => {
        const { name: server, config } = connection.entry
        for (const toolName of registered.get(server) ?? []) {
          if (registry.discoveredTools.has(toolName)) {
            preservedDiscovered.add(toolName)
          }
          registry.unregister(toolName)
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
            registry.register(
              createMcpTool({
                server,
                tool,
                name,
                exposure: toolExposureOf(config, tool.name),
                namespace,
                caller: connection,
              }),
            )
            if (preservedDiscovered.has(name)) {
              registry.discoveredTools.add(name)
            }
            names.push(name)
            owners.set(name, owner)
          } catch (error) {
            options.logger?.error(
              `[mcp] ${server}: could not register ${tool.name}: ${error instanceof Error ? error.message : error}`,
            )
          }
        }
        registered.set(server, names)
      }

      const lease = pool.acquire({
        cwd,
        entries,
        errors,
        ...(options.createTransport
          ? { createTransport: options.createTransport }
          : {}),
        onTools: syncTools,
        onError: (problems) => {
          for (const problem of problems) {
            options.logger?.error(`[mcp] ${problem}`)
          }
        },
      })

      try {
        if (lease.hasWork) {
          lease.start()
          const extraServers = new Set<string>()
          for (const entry of entries) {
            if (entry.config.enabled === false) continue
            const prefix = `${namespaceName(entry.name)}__`
            if (discoveredTools.some((t) => t.startsWith(prefix))) {
              extraServers.add(entry.name)
            }
          }
          await lease.waitForDirect(
            waitMs,
            extraServers.size > 0 ? extraServers : undefined,
            signal,
          )
        }

        return {
          waitForAll: (waitSignal) => lease.waitForAll(waitSignal ?? signal),
          release: () => lease.release(),
        }
      } catch (error) {
        await lease.release().catch(() => {})
        throw error
      }
    },
    async dispose() {
      if (ownsPool) {
        await pool.dispose()
      }
    },
  }
}
