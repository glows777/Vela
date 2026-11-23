import type { VelaSession } from '../extension-api.ts'
import { WorkspacePreparationError } from './log.ts'
import type { IncomingMessage } from './types.ts'

/** Resolve file markers only after the gateway has selected the receiving session. */
export async function materializeAttachments(
  session: VelaSession,
  message: IncomingMessage,
  signal?: AbortSignal,
): Promise<IncomingMessage> {
  if (!message.files?.length) return message
  try {
    const env = await session.execEnv(signal)

    // The trigger follows historical context. Match the descriptors from the end
    // so repeated names retain their order and historical placeholders stay intact.
    let text = message.text
    let end = text.length
    for (const file of [...message.files].reverse()) {
      const marker = `[file: ${file.name}]`
      const index = text.slice(0, end).lastIndexOf(marker)
      if (index < 0)
        throw new Error('Attachment marker missing from prepared message')
      const path = await session.store.uploads.materialize(env, file, signal)
      text = `${text.slice(0, index)}[file: ${file.name}, saved at ${path}]${text.slice(index + marker.length)}`
      end = index
    }
    return { ...message, text, files: undefined }
  } catch (error) {
    if (session.location.environment !== 'local' && !signal?.aborted)
      throw new WorkspacePreparationError(error)
    throw error
  }
}
