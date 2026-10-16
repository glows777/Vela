import { Buffer } from 'node:buffer'

/** Recognize image signatures without trying to decode possibly incomplete bytes. */
export function imageMimeType(header: Buffer): string | undefined {
  if (
    header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png'
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff)
    return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(header.toString('ascii', 0, 6)))
    return 'image/gif'
  if (
    header.toString('ascii', 0, 4) === 'RIFF' &&
    header.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp'
  // "BM" also starts ordinary prose. Require the binary BMP file header and a
  // recognized DIB header size before treating text as an image.
  if (
    header.length >= 18 &&
    header.toString('ascii', 0, 2) === 'BM' &&
    header.readUInt32LE(6) === 0
  ) {
    const dibSize = header.readUInt32LE(14)
    const pixelOffset = header.readUInt32LE(10)
    if (
      [12, 16, 40, 52, 56, 64, 108, 124].includes(dibSize) &&
      pixelOffset >= 14 + dibSize &&
      header.readUInt32LE(2) >= pixelOffset
    )
      return 'image/bmp'
  }
  return undefined
}

/** Detect binary content without rejecting non-ASCII UTF-8 text. */
export function isBinaryFile(header: Buffer): boolean {
  return header.subarray(0, 8192).includes(0)
}

interface ImageMetadata {
  mimeType: string
  width: number
  height: number
  orientation: number
}

/** Read only bounded headers before the decoder allocates the bitmap. */
export function imageMetadata(bytes: Buffer): ImageMetadata | undefined {
  if (bytes.length < 12) return undefined
  const result = { mimeType: '', width: 0, height: 0, orientation: 1 }
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    if (bytes.length < 33 || bytes.toString('ascii', 12, 16) !== 'IHDR')
      return undefined
    result.mimeType = 'image/png'
    result.width = bytes.readUInt32BE(16)
    result.height = bytes.readUInt32BE(20)
    for (let offset = 8; offset + 12 <= bytes.length; ) {
      const length = bytes.readUInt32BE(offset)
      if (length > bytes.length - offset - 12) break
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'eXIf') {
        result.orientation = exifOrientation(
          bytes.subarray(offset + 8, offset + 8 + length),
        )
      }
      offset += length + 12
    }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    result.mimeType = 'image/jpeg'
    for (let offset = 2; offset + 4 <= bytes.length; ) {
      if (bytes[offset++] !== 0xff) return undefined
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]!
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > bytes.length) return undefined
      const length = bytes.readUInt16BE(offset)
      if (length < 2 || length > bytes.length - offset) return undefined
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        if (length < 8) return undefined
        result.height = bytes.readUInt16BE(offset + 3)
        result.width = bytes.readUInt16BE(offset + 5)
      } else if (
        marker === 0xe1 &&
        bytes.toString('ascii', offset + 2, offset + 8) === 'Exif\0\0'
      ) {
        result.orientation = exifOrientation(
          bytes.subarray(offset + 2, offset + length),
        )
      }
      offset += length
    }
  } else if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) {
    result.mimeType = 'image/gif'
    result.width = bytes.readUInt16LE(6)
    result.height = bytes.readUInt16LE(8)
  } else if (
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    result.mimeType = 'image/webp'
    for (let offset = 12; offset + 8 <= bytes.length; ) {
      const length = bytes.readUInt32LE(offset + 4)
      const start = offset + 8
      if (length > bytes.length - start) return undefined
      const kind = bytes.toString('ascii', offset, offset + 4)
      if (kind === 'VP8X' && length >= 10) {
        result.width = bytes.readUIntLE(start + 4, 3) + 1
        result.height = bytes.readUIntLE(start + 7, 3) + 1
      } else if (kind === 'VP8 ' && length >= 10 && !result.width) {
        result.width = bytes.readUInt16LE(start + 6) & 0x3fff
        result.height = bytes.readUInt16LE(start + 8) & 0x3fff
      } else if (kind === 'VP8L' && length >= 5 && !result.width) {
        const dimensions = bytes.readUInt32LE(start + 1)
        result.width = (dimensions & 0x3fff) + 1
        result.height = ((dimensions >>> 14) & 0x3fff) + 1
      } else if (kind === 'EXIF') {
        result.orientation = exifOrientation(
          bytes.subarray(start, start + length),
        )
      }
      offset = start + length + (length % 2)
    }
  } else if (bytes.toString('ascii', 0, 2) === 'BM') {
    if (bytes.length < 26) return undefined
    result.mimeType = 'image/bmp'
    const dibLength = bytes.readUInt32LE(14)
    if (dibLength === 12) {
      result.width = bytes.readUInt16LE(18)
      result.height = bytes.readUInt16LE(20)
    } else if (dibLength >= 40 && bytes.length >= 54) {
      result.width = bytes.readInt32LE(18)
      result.height = Math.abs(bytes.readInt32LE(22))
    }
  }
  return result.width > 0 && result.height > 0 ? result : undefined
}

function exifOrientation(data: Buffer): number {
  const bytes = data.subarray(
    data.toString('ascii', 0, 6) === 'Exif\0\0' ? 6 : 0,
  )
  if (bytes.length < 8) return 1
  const order = bytes.toString('ascii', 0, 2)
  if (order !== 'II' && order !== 'MM') return 1
  const u16 = (offset: number) =>
    order === 'II' ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset)
  const u32 = (offset: number) =>
    order === 'II' ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset)
  if (u16(2) !== 42) return 1
  const ifd = u32(4)
  if (ifd > bytes.length - 2) return 1
  const count = u16(ifd)
  for (let index = 0; index < count; index++) {
    const entry = ifd + 2 + index * 12
    if (entry + 12 > bytes.length) return 1
    if (u16(entry) === 0x0112 && u16(entry + 2) === 3 && u32(entry + 4) === 1) {
      const orientation = u16(entry + 8)
      return orientation >= 1 && orientation <= 8 ? orientation : 1
    }
  }
  return 1
}
