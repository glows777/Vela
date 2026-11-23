import { Buffer } from 'node:buffer'
import { basename } from 'node:path'
import type { ChannelDefinition } from '../legacy-channels/index.ts'
import { imageMetadata, imageMimeType } from '../shared/images/index.ts'
import {
  LarkResponseError,
  type LarkTransport,
  LarkUploadError,
} from './transport.ts'

/** Feishu's native IM image limits. Other pictures can still be delivered as files. */
function nativeImage(bytes: Uint8Array): boolean {
  if (bytes.byteLength > 10_000_000) return false
  const header = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    Math.min(bytes.byteLength, 65_536),
  )
  const mime = imageMimeType(header)
  if (mime) {
    const info = imageMetadata(header)
    const dimension = mime === 'image/gif' ? 2_000 : 12_000
    return !info || (info.width <= dimension && info.height <= dimension)
  }
  // ICO, TIFF and HEIC are accepted by Feishu in addition to the core image formats.
  const signature = header.toString('hex', 0, 4)
  if (
    ['00000100', '49492a00', '4d4d002a', '49492b00', '4d4d002b'].includes(
      signature,
    )
  )
    return true
  if (header.toString('ascii', 4, 8) !== 'ftyp') return false
  const end = Math.min(header.readUInt32BE(0), header.length)
  for (let offset = 8; offset + 4 <= end; offset += 4) {
    if (
      offset !== 12 &&
      ['heic', 'heix', 'hevc', 'hevx'].includes(
        header.toString('ascii', offset, offset + 4),
      )
    )
      return true
  }
  return false
}

export function channelFileSender(
  transport: LarkTransport,
  changed: (
    route: Parameters<NonNullable<ChannelDefinition['sendFile']>>[0],
  ) => void,
): NonNullable<ChannelDefinition['sendFile']> {
  return async (route, file) => {
    const name = basename(file.path)
    const kind = nativeImage(file.bytes) ? 'image' : 'file'
    try {
      const receipt = await transport.sendFile!(
        route.channelId,
        { kind, name, bytes: file.bytes },
        {
          replyToId: route.topic?.rootId ?? route.replyToId,
          replyInThread: route.topic ? true : undefined,
          uuid: route.deliveryId,
        },
      )
      if (!receipt?.messageId) throw new Error('Missing message receipt')
    } catch (error) {
      if (error instanceof LarkUploadError) throw error
      if (error instanceof LarkResponseError) {
        // Only the bounded first line belongs in the conversation.
        throw new Error(
          error.message.split(/[\p{Cc}\u2028\u2029]/u, 1)[0]!.slice(0, 300),
        )
      }
      throw new Error(
        'Lark did not confirm delivery. Check this conversation before asking me to resend.',
        { cause: error },
      )
    }
    changed(route)
  }
}
