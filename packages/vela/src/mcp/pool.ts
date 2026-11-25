import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerEntry } from './config.ts'
import { McpConnection } from './connection.ts'

const DEFAULT_IDLE_TTL_MS = 5 * 60_000

function canonicalDir(dir: string): string {
  const resolved = resolve(dir)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stableJson((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

function mcpPoolKey(cwd: string, entries: readonly McpServerEntry[]): string {
  const canonicalCwd = canonicalDir(cwd)
  const normalized = [...entries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      name: entry.name,
      config: stableJson(entry.config),
    }))
  const hash = createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex')
  return JSON.stringify([canonicalCwd, hash])
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
  entries: readonly McpServerEntry[],
  connections: ReadonlyMap<string, McpConnection>,
  registered: ReadonlyMap<string, string[]>,
  errors: readonly string[],
): string {
  if (entries.length === 0 && errors.length === 0)
    return 'No MCP servers configured. Add mcpServers to ~/.vela/config.json or .vela/config.json (see docs/mcp.md).'
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

interface LeaseCallbacks {
  onTools: (connection: McpConnection) => void
  onError: (problems: string[]) => void
  reportedConfig: boolean
  reportedConnect: boolean
}

interface PoolBucket {
  readonly key: string
  readonly cwd: string
  readonly entries: readonly McpServerEntry[]
  readonly errors: readonly string[]
  readonly connections: Map<string, McpConnection>
  readonly leases: Set<LeaseCallbacks>
  started?: Promise<string[]>
  directReady: Promise<void>
  idleTimer?: ReturnType<typeof setTimeout>
  closing?: Promise<void>
}

export interface McpPoolOptions {
  /** Idle eviction delay after the last session releases a bucket (default 5 min; 0 = immediate). */
  idleTtlMs?: number
}

export interface McpPoolAcquireOptions {
  cwd: string
  entries: readonly McpServerEntry[]
  errors: readonly string[]
  createTransport?: (entry: McpServerEntry, cwd: string) => Promise<Transport>
  onTools: (connection: McpConnection) => void
  onError: (problems: string[]) => void
}

export interface McpPoolLease {
  readonly key: string
  readonly hasWork: boolean
  start(): void
  waitForDirect(timeoutMs: number): Promise<void>
  waitForAll(): Promise<void>
  reconnect(
    server: string | undefined,
  ): Promise<
    | { ok: true; connection: McpConnection }
    | { ok: false; kind: 'unknown'; available: string[] }
    | { ok: false; kind: 'error'; message: string }
  >
  status(registered: ReadonlyMap<string, string[]>): string
  release(): Promise<void>
}

/**
 * Per-project (`cwd` + `mcpServers` config hash) MCP connection pool with
 * reference-counted sharing and idle eviction.
 */
export class McpPool {
  private readonly idleTtlMs: number
  private readonly buckets = new Map<string, PoolBucket>()
  private disposed = false

  constructor(options: McpPoolOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
  }

  get size(): number {
    return this.buckets.size
  }

  has(key: string): boolean {
    return this.buckets.has(key)
  }

  acquire(options: McpPoolAcquireOptions): McpPoolLease {
    if (this.disposed) throw new Error('McpPool has been disposed')
    const key = mcpPoolKey(options.cwd, options.entries)
    let bucket = this.buckets.get(key)
    if (!bucket) {
      const connections = new Map<string, McpConnection>()
      const leases = new Set<LeaseCallbacks>()
      const created: PoolBucket = {
        key,
        cwd: canonicalDir(options.cwd),
        entries: [...options.entries],
        errors: [...options.errors],
        connections,
        leases,
        directReady: Promise.resolve(),
      }
      for (const entry of options.entries) {
        if (entry.config.enabled === false) continue
        connections.set(
          entry.name,
          new McpConnection({
            entry,
            cwd: options.cwd,
            onTools: (connection) => {
              for (const cb of created.leases) cb.onTools(connection)
            },
            ...(options.createTransport
              ? { createTransport: options.createTransport }
              : {}),
          }),
        )
      }
      this.buckets.set(key, created)
      bucket = created
    }

    if (bucket.idleTimer) {
      clearTimeout(bucket.idleTimer)
      bucket.idleTimer = undefined
    }

    const leaseState: LeaseCallbacks = {
      onTools: options.onTools,
      onError: options.onError,
      reportedConfig: false,
      reportedConnect: false,
    }
    bucket.leases.add(leaseState)

    // Sync tools for connections that are already populated in this pooled bucket.
    for (const connection of bucket.connections.values()) {
      if (connection.tools.length > 0 || connection.instructions) {
        options.onTools(connection)
      }
    }

    const activeBucket = bucket
    let released = false

    const start = () => {
      if (released || this.disposed) return
      if (!leaseState.reportedConfig && activeBucket.errors.length > 0) {
        leaseState.reportedConfig = true
        leaseState.onError([...activeBucket.errors])
      }
      if (!activeBucket.started) {
        const attempts = [...activeBucket.connections.values()].map(
          (connection) => ({
            connection,
            done: connection.connect().then(
              () => undefined,
              (error: unknown) =>
                error instanceof Error ? error.message : String(error),
            ),
          }),
        )
        activeBucket.directReady = Promise.all(
          attempts
            .filter(({ connection }) => hasDirectTools(connection.entry))
            .map(({ done }) => done),
        ).then(() => {})
        activeBucket.started = Promise.all(
          attempts.map(({ done }) => done),
        ).then((failures) => {
          const problems = failures.filter((f): f is string => f !== undefined)
          if (problems.length > 0) {
            for (const cb of activeBucket.leases) {
              if (!cb.reportedConnect) {
                cb.reportedConnect = true
                cb.onError(problems)
              }
            }
          }
          return problems
        })
      } else {
        void activeBucket.started.then((problems) => {
          if (!released && !leaseState.reportedConnect && problems.length > 0) {
            leaseState.reportedConnect = true
            leaseState.onError(problems)
          }
        })
      }
    }

    return {
      key,
      hasWork:
        activeBucket.connections.size > 0 || activeBucket.errors.length > 0,
      start,
      waitForDirect: async (timeoutMs) => {
        if (!activeBucket.started) return
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          activeBucket.directReady,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs)
          }),
        ])
        clearTimeout(timer)
      },
      waitForAll: async () => {
        if (activeBucket.started) await activeBucket.started
      },
      reconnect: async (server) => {
        const connection = server
          ? activeBucket.connections.get(server)
          : undefined
        if (!connection) {
          return {
            ok: false,
            kind: 'unknown',
            available: [...activeBucket.connections.keys()],
          }
        }
        try {
          await connection.reconnect()
          return { ok: true, connection }
        } catch (error) {
          return {
            ok: false,
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          }
        }
      },
      status: (registered) =>
        statusReport(
          activeBucket.entries,
          activeBucket.connections,
          registered,
          activeBucket.errors,
        ),
      release: async () => {
        if (released) return
        released = true
        activeBucket.leases.delete(leaseState)
        if (activeBucket.leases.size > 0 || this.disposed) return
        if (this.idleTtlMs <= 0) {
          await this.evict(activeBucket)
          return
        }
        activeBucket.idleTimer = setTimeout(() => {
          activeBucket.idleTimer = undefined
          if (activeBucket.leases.size === 0) {
            void this.evict(activeBucket)
          }
        }, this.idleTtlMs)
        activeBucket.idleTimer.unref?.()
      },
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const current = [...this.buckets.values()]
    this.buckets.clear()
    await Promise.all(current.map((bucket) => this.closeBucket(bucket)))
  }

  private async evict(bucket: PoolBucket): Promise<void> {
    if (this.buckets.get(bucket.key) === bucket) {
      this.buckets.delete(bucket.key)
    }
    await this.closeBucket(bucket)
  }

  private closeBucket(bucket: PoolBucket): Promise<void> {
    if (bucket.idleTimer) {
      clearTimeout(bucket.idleTimer)
      bucket.idleTimer = undefined
    }
    bucket.closing ??= Promise.all(
      [...bucket.connections.values()].map((connection) => connection.close()),
    ).then(() => undefined)
    return bucket.closing
  }
}
