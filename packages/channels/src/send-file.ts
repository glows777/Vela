import { createHash } from 'node:crypto'
import { basename, isAbsolute, relative, sep, win32 } from 'node:path'
import type { ExecutionEnv, FileError, Result } from '@glows777/vela-core'
import type {
  ExtensionAPI,
  VelaSession,
} from '@glows777/vela-core/extension-api'
import { z } from 'zod'
import type { ChannelDefinition, IncomingMessage } from './types.ts'

const MAX_BYTES = 30_000_000
const outside = 'Choose a file inside this workspace using a relative path.'

async function readWorkspaceFile(
  env: ExecutionEnv,
  path: string,
  signal?: AbortSignal,
) {
  const name = basename(path)
  if (
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path.split(/[\\/]/).includes('..') ||
    /\p{Cc}/u.test(path)
  )
    throw new Error(outside)
  function value<T>(result: Result<T, FileError>): T {
    if (result.ok) return result.value
    signal?.throwIfAborted()
    if (result.error.code === 'not_found')
      throw new Error(`${name} was not found in this workspace.`)
    if (result.error.code === 'permission_denied')
      throw new Error(`Permission denied reading ${name}.`)
    throw new Error(
      `Cannot read ${name} as a workspace file (${result.error.code}).`,
    )
  }
  const root = value(await env.canonicalPath(env.cwd, signal))
  const resolved = value(
    await env.canonicalPath(
      value(await env.joinPath([root, path], signal)),
      signal,
    ),
  )
  const within = relative(root, resolved)
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
    throw new Error(outside)
  const reader = value(
    await env.openBinaryReader(resolved, { noFollow: true }, signal),
  )
  const checkSize = (size: number) => {
    if (size === 0) throw new Error(`${name} is empty. Choose a nonempty file.`)
    if (size > MAX_BYTES)
      throw new Error(`${name} exceeds the 30 MB file limit.`)
  }
  try {
    const info = value(await reader.info(signal))
    if (info.kind !== 'file') throw new Error(`${name} is not a regular file.`)
    checkSize(info.size)
    const bytes = value(await reader.read(0, info.size + 1, signal))
    checkSize(bytes.byteLength)
    if (bytes.byteLength !== info.size)
      throw new Error(
        `${name} changed while it was being read. Send it again after writing finishes.`,
      )
    return bytes
  } finally {
    await reader.close()
  }
}

export function registerSendFile(
  api: ExtensionAPI,
  resolve: (id: string) =>
    | {
        session: VelaSession
        message: IncomingMessage
        channel: ChannelDefinition
      }
    | undefined,
) {
  api.registerTool({
    name: 'send_file',
    channel: true,
    activeByDefault: false,
    description:
      'Send one file from this workspace to the current conversation. Supply its workspace-relative path. Report a delivery error in one clear line. If delivery is uncertain, ask the user to check the conversation and wait for them to request another send.',
    inputSchema: z.object({ path: z.string().min(1) }).strict(),
    executionMode: 'sequential',
    replay: 'unsafe',
    execute: async ({ path }: { path: string }, ctx) => {
      const id = ctx?.sessionId
      const run = id ? resolve(id) : undefined
      if (!ctx || !run?.channel.sendFile)
        throw new Error(
          'Sending a file requires an active conversation that supports file delivery.',
        )
      const { session, message } = run
      const bytes = await readWorkspaceFile(
        await session.execEnv(ctx.signal),
        path,
        ctx.signal,
      )
      ctx.signal?.throwIfAborted()
      const deliveryId =
        ctx.toolCallId &&
        createHash('sha256')
          .update(JSON.stringify([session.id, ctx.toolCallId]))
          .digest('hex')
          .slice(0, 40)
      await run.channel.sendFile(
        {
          channelId: message.channelId,
          topic: message.topic,
          replyToId: message.replyToId,
          recipientId: message.senderId,
          routine: message.routine,
          handoff: message.handoff,
          deliveryId,
        },
        { path, bytes },
      )
      return `Sent ${basename(path)}.`
    },
  })
}
