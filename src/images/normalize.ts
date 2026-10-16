import type { PhotonImage } from '@silvia-odwyer/photon-node'
import type { ImageContent } from '../messages.ts'
import { imageMetadata } from './metadata.ts'

const MAX_DIMENSION = 2000
const MAX_BASE64_LENGTH = 4.5 * 1024 * 1024
// Bound allocation before calling WASM on untrusted, potentially compressed input.
const MAX_DECODE_PIXELS = 64 * 1024 * 1024
const MAX_INPUT_LENGTH = 128 * 1024 * 1024
const JPEG_QUALITY = 80

type Photon = typeof import('@silvia-odwyer/photon-node')
let photonPromise: Promise<Photon> | undefined

/** Validate and bound provider image input without exposing decoder errors or data. */
export async function normalizeImage(
  image: ImageContent,
): Promise<{ image?: ImageContent; reason?: string }> {
  if (typeof image.data !== 'string' || !image.data.length) {
    return { reason: 'invalid image data' }
  }
  if (image.data.length > MAX_INPUT_LENGTH) {
    return { reason: 'image exceeds the safe decoding size limit' }
  }
  if (
    image.data.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
  ) {
    return { reason: 'invalid image base64 data' }
  }
  const bytes = Buffer.from(image.data, 'base64')
  if (
    bytes.toString('base64').replace(/=+$/, '') !==
    image.data.replace(/=+$/, '')
  ) {
    return { reason: 'invalid image base64 data' }
  }
  const metadata = imageMetadata(bytes)
  if (!metadata) return { reason: 'unsupported or invalid image format' }
  if (metadata.width * metadata.height > MAX_DECODE_PIXELS) {
    return { reason: 'image exceeds the safe decoding dimension limit' }
  }

  let current: PhotonImage | undefined
  try {
    // The package's Node entry resolves its own adjacent WASM, including from dist/.
    // Load it only when an image is present; text-only requests do not initialize WASM.
    photonPromise ??= import('@silvia-odwyer/photon-node')
    const photon = await photonPromise
    current = photon.PhotonImage.new_from_byteslice(bytes)
    const replace = (next: PhotonImage) => {
      current?.free()
      current = next
    }
    const width = current.get_width()
    const height = current.get_height()
    if (width !== metadata.width || height !== metadata.height) {
      return { reason: 'invalid image dimensions' }
    }
    if (
      metadata.orientation === 1 &&
      metadata.mimeType !== 'image/bmp' &&
      Math.max(width, height) <= MAX_DIMENSION &&
      image.data.length <= MAX_BASE64_LENGTH
    ) {
      return {
        image: { type: 'image', data: image.data, mimeType: metadata.mimeType },
      }
    }

    switch (metadata.orientation) {
      case 2:
        photon.fliph(current)
        break
      case 3:
        replace(photon.rotate(current, 180))
        break
      case 4:
        photon.flipv(current)
        break
      case 5:
        photon.fliph(current)
        replace(photon.rotate(current, 270))
        break
      case 6:
        replace(photon.rotate(current, 90))
        break
      case 7:
        photon.fliph(current)
        replace(photon.rotate(current, 90))
        break
      case 8:
        replace(photon.rotate(current, 270))
        break
    }
    const scale = Math.min(
      1,
      MAX_DIMENSION / Math.max(current.get_width(), current.get_height()),
    )
    if (scale < 1) {
      replace(
        photon.resize(
          current,
          Math.max(1, Math.round(current.get_width() * scale)),
          Math.max(1, Math.round(current.get_height() * scale)),
          photon.SamplingFilter.Lanczos3,
        ),
      )
    }
    for (;;) {
      const data = Buffer.from(current.get_bytes_jpeg(JPEG_QUALITY)).toString(
        'base64',
      )
      if (data.length <= MAX_BASE64_LENGTH) {
        return { image: { type: 'image', data, mimeType: 'image/jpeg' } }
      }
      const width = current.get_width()
      const height = current.get_height()
      if (width === 1 && height === 1) {
        return { reason: 'image could not be reduced below the size limit' }
      }
      replace(
        photon.resize(
          current,
          Math.max(1, Math.floor(width * 0.85)),
          Math.max(1, Math.floor(height * 0.85)),
          photon.SamplingFilter.Lanczos3,
        ),
      )
    }
  } catch {
    return { reason: 'invalid image or image decoding failed' }
  } finally {
    current?.free()
  }
}
