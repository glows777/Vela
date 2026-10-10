/**
 * One MCP server connection on the official MCP SDK (pi uses its own pi-mcp client; the behavior
 * follows pi's `extensions/mcp/runtime.ts`). The SDK is imported only when a server connects, so
 * Vela without MCP servers never loads it.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  CallToolResult,
  Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js'
import type { McpServerEntry } from './config.ts'
import type { McpToolCaller } from './tools.ts'

const DEFAULT_TIMEOUT_SECONDS = 60
const STDERR_TAIL_CHARS = 2_000
/** Delays between attempts to connect to an HTTP server that failed with a transient error (like pi). */
const CONNECT_RETRY_DELAYS_MS = [250, 1_000]

/**
 * `disconnected`: the connection dropped (e.g. the stdio server exited); the next call reconnects.
 * `failed`: the last connect failed; the next call tries again.
 */
export type McpServerState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** HTTP status of an SDK transport error, when it has one. */
function httpStatus(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'number' && code >= 100 && code < 600
    ? code
    : undefined
}

/** Network failures and overloaded or restarting servers, worth another attempt (like pi). */
function isTransient(error: unknown): boolean {
  const status = httpStatus(error)
  if (status !== undefined)
    return status === 408 || status === 429 || (status >= 500 && status !== 501)
  return error instanceof TypeError
}

/** `~` and `~/…` name the home directory, like in a shell. */
function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\'))
    return join(homedir(), value.slice(2))
  return value
}

/** Vela's version for `initialize`, from package.json (three levels up from src/ and dist/). */
function velaVersion(): string {
  try {
    return (
      JSON.parse(
        readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
      ) as { version: string }
    ).version
  } catch {
    return '0.0.0'
  }
}

export interface McpConnectionOptions {
  entry: McpServerEntry
  /** The Vela's cwd: stdio servers' relative `cwd` resolves against it */
  cwd: string
  /** Called when the tool list or instructions change (after connect, or on `tools/list_changed`) */
  onTools: (connection: McpConnection) => void
  /** Called when `state` or `error` change */
  onChange?: (connection: McpConnection) => void
  /** Creates the transport; tests pass an in-memory one */
  createTransport?: (entry: McpServerEntry, cwd: string) => Promise<Transport>
}

/** One configured server, shared by all sessions of a Vela. Connects lazily and reconnects after a drop. */
export class McpConnection implements McpToolCaller {
  readonly entry: McpServerEntry
  state: McpServerState = 'idle'
  error: string | undefined
  tools: McpTool[] = []
  /** Server instructions from `initialize`, describing its tools as a group */
  instructions: string | undefined
  private client: Client | undefined
  private opening: Promise<Client> | undefined
  /** Aborted by close(): cancels a connect in progress, including the wait between retries */
  private readonly shutdown = new AbortController()
  private stderrTail = ''

  constructor(private readonly options: McpConnectionOptions) {
    this.entry = options.entry
  }

  get name(): string {
    return this.entry.name
  }

  private get timeoutMs(): number {
    return (this.entry.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000
  }

  private setState(state: McpServerState, error?: string): void {
    this.state = state
    this.error = error
    this.options.onChange?.(this)
  }

  /** Connects if not connected; concurrent callers share one attempt. */
  connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client)
    if (this.state === 'closed')
      return Promise.reject(
        new Error(`MCP server "${this.name}" has been shut down`),
      )
    this.opening ??= this.open().finally(() => {
      this.opening = undefined
    })
    return this.opening
  }

  private async open(): Promise<Client> {
    this.setState('connecting')
    const isHttp = 'url' in this.entry.config
    for (let attempt = 0; ; attempt++) {
      try {
        const client = await this.openOnce()
        if (this.shutdown.signal.aborted) {
          await client.close().catch(() => {})
          throw new Error('shut down')
        }
        this.client = client
        this.setState('connected')
        this.options.onTools(this)
        return client
      } catch (error) {
        const delay = CONNECT_RETRY_DELAYS_MS[attempt]
        if (
          isHttp &&
          delay !== undefined &&
          isTransient(error) &&
          !this.shutdown.signal.aborted
        ) {
          await sleep(delay, undefined, { signal: this.shutdown.signal }).catch(
            () => {},
          )
          if (!this.shutdown.signal.aborted) continue
        }
        const message = this.describeConnectError(error)
        if (this.state !== 'closed') this.setState('failed', message)
        throw new Error(message)
      }
    }
  }

  private describeConnectError(error: unknown): string {
    if (this.shutdown.signal.aborted)
      return `MCP server "${this.name}" has been shut down`
    const status = httpStatus(error)
    let message = `MCP server "${this.name}" failed to connect: ${errorMessage(error)}`
    if (status === 401 || status === 403)
      message += `. It requires sign-in, and Vela does not support MCP OAuth yet; set an Authorization header in its config instead`
    const tail = this.stderrTail.trim()
    if (tail) message += `\nServer stderr:\n${tail}`
    return message
  }

  private async openOnce(): Promise<Client> {
    const [
      { Client },
      { ToolListChangedNotificationSchema },
      { CfWorkerJsonSchemaValidator },
    ] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/types.js'),
      import('@modelcontextprotocol/sdk/validation/cfworker'),
    ])
    this.stderrTail = ''
    const transport = await (
      this.options.createTransport ?? this.createTransport
    )(this.entry, this.options.cwd)
    const stderr = (transport as { stderr?: NodeJS.ReadableStream | null })
      .stderr
    stderr?.on('data', (chunk: Buffer | string) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(
        -STDERR_TAIL_CHARS,
      )
    })
    const client = new Client(
      { name: 'vela', version: velaVersion() },
      {
        capabilities: {},
        // Vela already depends on @cfworker/json-schema; ajv would compile schemas with new Function
        jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      },
    )
    client.onclose = () => {
      if (this.client !== client) return
      this.client = undefined
      if (this.state !== 'closed')
        this.setState(
          'disconnected',
          `MCP server "${this.name}" disconnected${this.stderrTail.trim() ? `\nServer stderr:\n${this.stderrTail.trim()}` : ''}`,
        )
    }
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      void this.refreshTools(client).catch(() => {})
    })
    try {
      await client.connect(transport, { timeout: this.timeoutMs })
      this.instructions = client.getInstructions()?.trim() || undefined
      this.tools = await this.listTools(client)
    } catch (error) {
      await client.close().catch(() => {})
      throw error
    }
    return client
  }

  private async createTransport(
    entry: McpServerEntry,
    cwd: string,
  ): Promise<Transport> {
    const { config } = entry
    if ('url' in config) {
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      )
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers ?? {} },
      })
    }
    const { StdioClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/stdio.js'
    )
    return new StdioClientTransport({
      command: expandHome(config.command),
      args: config.args?.map(expandHome),
      // Like pi: the server inherits the environment, as bash does (the SDK's default passes only a few variables)
      // vela-boundary: allow
      env: { ...(process.env as Record<string, string>), ...config.env },
      cwd: resolve(cwd, expandHome(config.cwd ?? '.')),
      stderr: 'pipe',
    })
  }

  private async listTools(client: Client): Promise<McpTool[]> {
    const tools: McpTool[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, {
        timeout: this.timeoutMs,
      })
      tools.push(...page.tools)
      cursor = page.nextCursor
    } while (cursor)
    return tools
  }

  private async refreshTools(client: Client): Promise<void> {
    const tools = await this.listTools(client)
    if (this.client !== client) return
    this.tools = tools
    this.options.onTools(this)
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: {
      signal?: AbortSignal
      onProgress?: (progress: {
        progress: number
        total?: number
        message?: string
      }) => void
    },
  ): Promise<CallToolResult> {
    const client = await this.connect()
    // Tool calls are not retried: the server may already have performed them (like pi)
    return (await client.callTool({ name, arguments: args }, undefined, {
      signal: options.signal,
      timeout: this.timeoutMs,
      resetTimeoutOnProgress: true,
      ...(options.onProgress ? { onprogress: options.onProgress } : {}),
    })) as CallToolResult
  }

  /** Closes the connection (stdio: close stdin, then SIGTERM, then SIGKILL, as the SDK does). */
  async close(): Promise<void> {
    this.shutdown.abort()
    this.setState('closed')
    const client = this.client
    this.client = undefined
    await client?.close().catch(() => {})
  }

  /** Drops the connection and connects again (`/mcp reconnect`). */
  async reconnect(): Promise<void> {
    const client = this.client
    this.client = undefined
    await client?.close().catch(() => {})
    await this.connect()
  }
}
