import type { VelaSession } from '@glows777/vela-core/extension-api'
import type { IncomingMessage } from './types.ts'

/** Resolve file markers only after the gateway has selected the receiving session. */
export async function materializeAttachments(
  session: VelaSession,
  message: IncomingMessage,
  signal?: AbortSignal,
): Promise<IncomingMessage> {
  if (!message.files?.length) return message
  const env = await session.execEnv(signal)
  if (env.id !== 'node:local')
    throw new Error('File attachments require a local execution environment')

  // The trigger follows historical context. Match the descriptors from the end
  // so repeated names retain their order and historical placeholders stay intact.
  let text = message.text
  let end = text.length
  for (const { name, hostPath } of [...message.files].reverse()) {
    const marker = `[file: ${name}]`
    const index = text.slice(0, end).lastIndexOf(marker)
    if (index < 0)
      throw new Error('Attachment marker missing from prepared message')
    text = `${text.slice(0, index)}[file: ${name}, saved at ${hostPath}]${text.slice(index + marker.length)}`
    end = index
  }
  return { ...message, text, files: undefined }
}
