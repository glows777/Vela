import { createHash, randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import type { VelaSession } from '@glows777/vela-core/extension-api'
import type { IncomingMessage } from './types.ts'

/** Put channel files into the selected environment before publishing paths to the model. */
export async function materializeAttachments(
  session: VelaSession,
  message: IncomingMessage,
  signal?: AbortSignal,
): Promise<IncomingMessage> {
  if (!message.files?.length) return message
  const env = await session.execEnv()
  // Nonlocal locations remain fail-closed until an environment-owned stable artifact root is agreed.
  if (env.id !== 'node:local')
    throw new Error('Execution environment attachment root unavailable')
  await session.registry.results.ensurePrivateDirectory()
  const value = <T>(
    result: { ok: true; value: T } | { ok: false; error: Error },
  ): T => {
    if (!result.ok) throw result.error
    return result.value
  }
  let text = message.text
  for (const file of message.files) {
    const sessionKey = createHash('sha256')
      .update(session.id)
      .digest('hex')
      .slice(0, 24)
    const fileKey = createHash('sha256')
      .update(file.id)
      .update('\0')
      .update(file.name)
      .digest('hex')
      .slice(0, 32)
    const directory = value(
      await env.joinPath(
        [session.registry.results.dir, `attachments-${sessionKey}`],
        signal,
      ),
    )
    value(await env.createDir(directory, { recursive: true }, signal))
    const safe =
      file.name.replace(/[\\/:?*"<>|]/g, '_').replace(/[. ]+$/, '') || 'file'
    const extension = extname(safe).slice(0, 32)
    const stem = extension ? safe.slice(0, -extension.length) : safe
    const name =
      Array.from(stem)
        .reduce(
          (part, char) =>
            Buffer.byteLength(part + char + extension) <= 180
              ? part + char
              : part,
          '',
        )
        .replace(/[. ]+$/, '') + extension
    const path = value(
      await env.joinPath([directory, `${fileKey}-${name}`], signal),
    )
    let temporary: string | undefined
    try {
      if (!value(await env.exists(path, signal))) {
        temporary = value(
          await env.joinPath(
            [directory, `.vela-attachment-${randomUUID()}.part`],
            signal,
          ),
        )
        value(await env.writeFile(temporary, file.data, signal))
        value(await env.renameFile(temporary, path, signal))
      }
      const marker = `[file: ${file.name}]`
      const index = text.lastIndexOf(marker)
      if (index < 0)
        throw new Error('Attachment marker missing from prepared message')
      text = `${text.slice(0, index)}[file: ${file.name}, saved at ${path}]${text.slice(index + marker.length)}`
    } finally {
      if (temporary) await env.remove(temporary, { force: true }, undefined)
    }
  }
  return { ...message, text, files: undefined }
}
