import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { FileTooLarge, MAX_ATTACHMENT_BYTES } from './attachments.ts'
import { safeName } from './messages.ts'
import type { LarkMessageEvent, LarkTransport } from './transport.ts'

export async function downloadFile(
  message: LarkMessageEvent['message'],
  transport: LarkTransport | undefined,
  dataDir: string,
  storageDir: string,
): Promise<{ id: string; name: string; data: Uint8Array }> {
  const content = JSON.parse(message.content) as {
    file_key: string
    file_name?: string
  }
  if (!message.message_id || !content.file_key || !transport)
    throw new Error('File has no resource key or message id')
  const messageId = safeName(message.message_id, 64)
  const name = safeName(
    content.file_name ?? 'file',
    254 - Buffer.byteLength(messageId),
  )
  await mkdir(dataDir, { recursive: true })
  const root = await realpath(dataDir)
  const directory = resolve(
    root,
    relative(resolve(dataDir), resolve(storageDir)),
    'files',
  )
  await mkdir(directory, { recursive: true })
  if ((await realpath(directory)) !== directory)
    throw new Error('File directory must not contain symlinks')
  const path = join(directory, `${messageId}-${name}`)
  const stage = async () => {
    try {
      return {
        id: message.message_id!,
        name,
        data: new Uint8Array(await readFile(path)),
      }
    } finally {
      await rm(path, { force: true })
    }
  }
  try {
    const existing = await lstat(path)
    if (!existing.isFile())
      throw new Error('Attachment destination is not a regular file')
    return await stage()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // Only completed downloads get the replayable name. A crash may leave a .part file,
  // but redelivery cannot mistake those bytes for a completed attachment.
  const temporary = join(directory, `${randomUUID()}.part`)
  const file = await open(temporary, 'wx')
  try {
    const stream = await transport.getResource(
      message.message_id,
      content.file_key,
      'file',
    )
    let size = 0
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > MAX_ATTACHMENT_BYTES) throw new FileTooLarge()
      await file.writeFile(bytes)
    }
    await file.close()
    await rename(temporary, path)
  } finally {
    await file.close()
    await rm(temporary, { force: true })
  }
  return await stage()
}
