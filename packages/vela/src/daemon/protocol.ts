import { existsSync, readFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { AuthEvent, AuthPrompt } from '../providers/auth/types.ts'
import type {
  ChannelRuntimeEvent,
  ChannelStatusInfo,
  RuntimeEvent,
  RuntimeWebhookStatus,
  StreamDeltaEvent,
} from '../runtime/index.ts'

export const DAEMON_PROTOCOL_VERSION = 4
const MAX_WIRE_FRAME_BYTES = 128 * 1024 * 1024

declare const __VELA_SDK_VERSION__: string | undefined

export interface DaemonHello {
  protocolVersion: number
  appVersion: string
  pid: number
  instanceId?: string
  agentDir: string
  startedAt: string
  socketPath: string
}

export interface DaemonStatus {
  running: boolean
  agentDir: string
  socketPath: string
  pid?: number
  protocolVersion?: number
  appVersion?: string
  startedAt?: string
  uptimeMs?: number
  channels?: ChannelStatusInfo[]
  webhooks?: RuntimeWebhookStatus
}

export interface SerializedError {
  message: string
  name?: string
  code?: string
  cause?: SerializedError | string
}

type DaemonRequest = {
  type: 'req'
  id: number
  method: string
  params?: unknown
}

type DaemonResponse =
  | { type: 'res'; id: number; ok: true; result: unknown }
  | { type: 'res'; id: number; ok: false; error: SerializedError }

type DaemonPushMessage =
  | { type: 'event'; event: RuntimeEvent }
  | { type: 'delta'; delta: StreamDeltaEvent }
  | { type: 'channel_event'; event: ChannelRuntimeEvent }
  | { type: 'auth_event'; loginId: number; event: AuthEvent }
  | {
      type: 'auth_prompt'
      loginId: number
      promptId: number
      prompt: AuthPrompt
    }
  | {
      type: 'auth_prompt_cancel'
      loginId: number
      promptId: number
    }

type DaemonClientControlMessage =
  | {
      type: 'auth_prompt_reply'
      loginId: number
      promptId: number
      value?: string
      error?: string
    }
  | { type: 'auth_cancel'; loginId: number }
  | { type: 'logout_cancel'; logoutId: number }
  | { type: 'discovery_cancel'; setupId: number }

export type DaemonWireMessage =
  | DaemonRequest
  | DaemonResponse
  | DaemonPushMessage
  | DaemonClientControlMessage

let cachedVersion: string | undefined

/** Reads the Vela package version (cached), honoring build-time injection in single-file bundles. */
export function getAppVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion
  if (
    typeof __VELA_SDK_VERSION__ === 'string' &&
    __VELA_SDK_VERSION__.length > 0
  ) {
    cachedVersion = __VELA_SDK_VERSION__
    return cachedVersion
  }
  let cur = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth++) {
    const pkgPath = join(cur, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          name?: string
          version?: string
        }
        if (
          typeof parsed.version === 'string' &&
          parsed.version !== '0.0.0' &&
          (parsed.name === '@glows777/vela' || parsed.name === 'vela-workspace')
        ) {
          cachedVersion = parsed.version
          return cachedVersion
        }
      } catch {}
    }
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  cachedVersion = '0.0.0'
  return cachedVersion
}

/** Encodes `Uint8Array` instances inside plain JSON-compatible structures as base64 markers. */
export function encodeIpcValue(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (value instanceof Uint8Array) {
    return { __velaBytes: Buffer.from(value).toString('base64') }
  }
  if (Array.isArray(value)) {
    return value.map((item) => encodeIpcValue(item))
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) {
        out[k] = encodeIpcValue(v)
      }
    }
    return out
  }
  return value
}

/** Decodes `__velaBytes` base64 markers back into `Uint8Array` instances. */
export function decodeIpcValue(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) {
    return value.map((item) => decodeIpcValue(item))
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (
      typeof record.__velaBytes === 'string' &&
      Object.keys(record).length === 1
    ) {
      return new Uint8Array(Buffer.from(record.__velaBytes, 'base64'))
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(record)) {
      out[k] = decodeIpcValue(v)
    }
    return out
  }
  return value
}

function serializeCause(
  cause: unknown,
  depth: number,
): SerializedError | string | undefined {
  if (cause === undefined || depth >= 3) return undefined
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code
    const nested = serializeCause(cause.cause, depth + 1)
    return {
      message: cause.message,
      name: cause.name,
      ...(typeof code === 'string' ? { code } : {}),
      ...(nested !== undefined ? { cause: nested } : {}),
    }
  }
  return String(cause)
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    const cause = serializeCause(error.cause, 0)
    return {
      message: error.message,
      name: error.name,
      ...(typeof code === 'string' ? { code } : {}),
      ...(cause !== undefined ? { cause } : {}),
    }
  }
  return { message: String(error) }
}

export function deserializeError(err: SerializedError): Error {
  const causeOption =
    err.cause !== undefined
      ? {
          cause:
            typeof err.cause === 'string'
              ? err.cause
              : deserializeError(err.cause),
        }
      : undefined
  const out = new Error(err.message, causeOption)
  if (err.name) out.name = err.name
  if (err.code) {
    ;(out as NodeJS.ErrnoException).code = err.code
  }
  return out
}

export function encodeWireLine(message: DaemonWireMessage): string {
  return `${JSON.stringify(encodeIpcValue(message))}\n`
}

/** Incremental NDJSON line parser over a byte/string stream using streaming UTF-8 decoding and bounded frames. */
export function createNdjsonParser(
  onMessage: (message: DaemonWireMessage) => void,
  onParseError?: (error: unknown, rawLine: string) => void,
  maxFrameBytes = MAX_WIRE_FRAME_BYTES,
): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let oversized = false
  return (chunk) => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    buffer += text
    for (;;) {
      const newlineIdx = buffer.indexOf('\n')
      if (newlineIdx === -1) {
        if (Buffer.byteLength(buffer, 'utf8') > maxFrameBytes) {
          oversized = true
          buffer = ''
          onParseError?.(
            new Error(`IPC frame exceeded ${maxFrameBytes} byte limit`),
            '',
          )
        }
        break
      }
      const line = buffer.slice(0, newlineIdx).trim()
      buffer = buffer.slice(newlineIdx + 1)
      if (oversized) {
        oversized = false
        continue
      }
      if (!line.length) continue
      if (Buffer.byteLength(line, 'utf8') > maxFrameBytes) {
        onParseError?.(
          new Error(`IPC frame exceeded ${maxFrameBytes} byte limit`),
          '',
        )
        continue
      }
      let parsed: DaemonWireMessage
      try {
        parsed = decodeIpcValue(JSON.parse(line)) as DaemonWireMessage
      } catch (error) {
        onParseError?.(error, line)
        continue
      }
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        typeof (parsed as { type?: unknown }).type !== 'string'
      ) {
        onParseError?.(new Error('Invalid IPC message'), line)
        continue
      }
      onMessage(parsed)
    }
  }
}

export function parseChannelSetEnabledParams(p: unknown): {
  name: string
  enabled: boolean
} {
  const obj = p as Record<string, unknown> | null | undefined
  if (
    !obj ||
    typeof obj !== 'object' ||
    typeof obj.name !== 'string' ||
    !obj.name.trim() ||
    typeof obj.enabled !== 'boolean'
  ) {
    throw new Error(
      'Invalid channels.setEnabled params: expected { name: string, enabled: boolean }',
    )
  }
  return { name: obj.name.trim(), enabled: obj.enabled }
}

export function parseChannelChatsParams(p: unknown): { channel: string } {
  const obj = p as Record<string, unknown> | null | undefined
  if (
    !obj ||
    typeof obj !== 'object' ||
    typeof obj.channel !== 'string' ||
    !obj.channel.trim()
  ) {
    throw new Error(
      'Invalid channels.chats params: expected { channel: string }',
    )
  }
  return { channel: obj.channel.trim() }
}

const channelSubmitSchema = z
  .object({
    channel: z.string().trim().min(1),
    input: z
      .object({
        chatId: z.string().trim().min(1),
        threadId: z.string().trim().min(1).optional(),
        replyToMessageId: z.string().trim().min(1).optional(),
        sessionId: z.string().trim().min(1).optional(),
        newTopic: z
          .object({
            title: z.string().trim().min(1),
          })
          .strict()
          .optional(),
        text: z.string(),
        author: z
          .object({
            id: z.string().min(1),
            name: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()

export function parseChannelSubmitParams(p: unknown): {
  channel: string
  input: import('../runtime/channels.ts').ChannelHostSubmitInput
} {
  const parsed = channelSubmitSchema.safeParse(p)
  if (!parsed.success) {
    throw new Error(
      `Invalid channels.submit params: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    )
  }
  return parsed.data
}

const MAX_CLIENT_BUFFER_BYTES = 64 * 1024 * 1024

export async function probeSocketAlive(socketPath: string): Promise<boolean> {
  if (process.platform !== 'win32' && !existsSync(socketPath)) return false
  return new Promise<boolean>((resolve) => {
    const probe = createConnection(socketPath)
    let done = false
    const finish = (alive: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      probe.destroy()
      resolve(alive)
    }
    const timer = setTimeout(() => finish(false), 400)
    probe.on('connect', () => finish(true))
    probe.on('error', () => finish(false))
  })
}

export function safeWriteWire(socket: Socket, msg: DaemonWireMessage): void {
  if (socket.destroyed || !socket.writable) return
  if (socket.writableLength > MAX_CLIENT_BUFFER_BYTES) {
    socket.destroy()
    return
  }
  try {
    socket.write(encodeWireLine(msg))
  } catch {
    socket.destroy()
  }
}
