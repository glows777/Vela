import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PhotonImage } from '@silvia-odwyer/photon-node'
import { normalizeImage } from '../../../src/images/normalize.ts'
import type { ImageContent } from '../../../src/index.ts'

const MAX_BASE64_LENGTH = 4.5 * 1024 * 1024
const fixture = (name: string, mimeType: string): ImageContent => ({
  type: 'image',
  data: readFileSync(
    new URL(`../../../../../test/fixtures/images/${name}`, import.meta.url),
  ).toString('base64'),
  mimeType,
})
const decode = (image: ImageContent) =>
  PhotonImage.new_from_byteslice(Buffer.from(image.data, 'base64'))

for (const [name, mimeType] of [
  ['blue.png', 'image/png'],
  ['quadrants.jpg', 'image/jpeg'],
  ['quadrants.gif', 'image/gif'],
  ['quadrants.webp', 'image/webp'],
  ['orientation-1.jpg', 'image/jpeg'],
]) {
  test(`keeps small valid ${name} unchanged`, async () => {
    const image = fixture(name!, mimeType!)
    expect(await normalizeImage(image)).toEqual({ image })
  })
}

test('detects the actual format instead of trusting the declared MIME type', async () => {
  const image = fixture('blue.png', 'image/jpeg')
  const result = await normalizeImage(image)
  expect(result.image).toEqual({ ...image, mimeType: 'image/png' })
})

test('converts a BMP to JPEG with quality 80', async () => {
  const input = fixture('quadrants.bmp', 'image/bmp')
  const expected = decode(input)
  try {
    expect((await normalizeImage(input)).image).toEqual({
      type: 'image',
      data: Buffer.from(expected.get_bytes_jpeg(80)).toString('base64'),
      mimeType: 'image/jpeg',
    })
  } finally {
    expected.free()
  }
})

test('resizes the longest dimension to 2000 and keeps the aspect ratio', async () => {
  const input = fixture('wide.png', 'image/png')
  const original = decode(input)
  const result = await normalizeImage(input)
  expect(result.reason).toBeUndefined()
  expect(result.image!.data).not.toBe(input.data)
  const output = decode(result.image!)
  try {
    expect(Math.max(output.get_width(), output.get_height())).toBe(2000)
    expect(output.get_width() / output.get_height()).toBeCloseTo(
      original.get_width() / original.get_height(),
      0,
    )
    expect(result.image!.data.length).toBeLessThanOrEqual(MAX_BASE64_LENGTH)
  } finally {
    original.free()
    output.free()
  }
})

test('reduces oversized base64 even when both dimensions are below 2000', async () => {
  const pixels = new Uint8Array(1200 * 1200 * 4)
  let seed = 123456789
  for (let i = 0; i < pixels.length; i++) {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    pixels[i] = i % 4 === 3 ? 255 : seed & 255
  }
  const original = new PhotonImage(pixels, 1200, 1200)
  try {
    const input: ImageContent = {
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from(original.get_bytes()).toString('base64'),
    }
    expect(input.data.length).toBeGreaterThan(MAX_BASE64_LENGTH)
    const result = await normalizeImage(input)
    expect(result.image!.data.length).toBeLessThanOrEqual(MAX_BASE64_LENGTH)
    expect(result.image!.mimeType).toBe('image/jpeg')
    expect(result.image!.data).toBe(
      Buffer.from(original.get_bytes_jpeg(80)).toString('base64'),
    )
  } finally {
    original.free()
  }
})

test('keeps an extreme aspect ratio nonzero while resizing', async () => {
  const original = new PhotonImage(new Uint8Array(3000 * 4).fill(255), 3000, 1)
  try {
    const result = await normalizeImage({
      type: 'image',
      data: Buffer.from(original.get_bytes()).toString('base64'),
      mimeType: 'image/png',
    })
    const output = decode(result.image!)
    try {
      expect([output.get_width(), output.get_height()]).toEqual([2000, 1])
    } finally {
      output.free()
    }
  } finally {
    original.free()
  }
})

const cornerOrder = [
  ['red', 'green', 'blue', 'yellow'],
  ['green', 'red', 'yellow', 'blue'],
  ['yellow', 'blue', 'green', 'red'],
  ['blue', 'yellow', 'red', 'green'],
  ['red', 'blue', 'green', 'yellow'],
  ['blue', 'red', 'yellow', 'green'],
  ['yellow', 'green', 'blue', 'red'],
  ['green', 'yellow', 'red', 'blue'],
]
for (let orientation = 2; orientation <= 8; orientation++) {
  test(`applies EXIF orientation ${orientation} before encoding`, async () => {
    const result = await normalizeImage(
      fixture(`orientation-${orientation}.jpg`, 'image/jpeg'),
    )
    expect(result.image!.mimeType).toBe('image/jpeg')
    const output = decode(result.image!)
    try {
      const width = output.get_width()
      const height = output.get_height()
      expect([width, height]).toEqual(orientation >= 5 ? [40, 60] : [60, 40])
      const pixels = output.get_raw_pixels()
      const corners: string[] = [
        [5, 5],
        [width - 6, 5],
        [5, height - 6],
        [width - 6, height - 6],
      ].map(([x, y]) => {
        const offset = (y! * width + x!) * 4
        if (pixels[offset]! > 150)
          return pixels[offset + 1]! > 150 ? 'yellow' : 'red'
        return pixels[offset + 1]! > 150 ? 'green' : 'blue'
      })
      expect(corners).toEqual(cornerOrder[orientation - 1]!)
      expect(await normalizeImage(result.image!)).toEqual({
        image: result.image,
      })
    } finally {
      output.free()
    }
  })
}

for (const [name, data] of [
  ['empty input', ''],
  ['invalid base64', 'not-an-image'],
  ['data URL', 'data:image/png;base64,aGVsbG8='],
  ['base64 text', Buffer.from('private image payload').toString('base64')],
  ['truncated PNG', fixture('blue.png', 'image/png').data.slice(0, 40)],
  ['truncated JPEG', fixture('quadrants.jpg', 'image/jpeg').data.slice(0, 40)],
  ['truncated GIF', fixture('quadrants.gif', 'image/gif').data.slice(0, 20)],
  ['truncated WebP', fixture('quadrants.webp', 'image/webp').data.slice(0, 20)],
  ['truncated BMP', fixture('quadrants.bmp', 'image/bmp').data.slice(0, 20)],
  [
    'SVG',
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
  ],
]) {
  test(`drops ${name} with a safe reason`, async () => {
    const result = await normalizeImage({
      type: 'image',
      data: data!,
      mimeType: 'image/png',
    })
    expect(result.image).toBeUndefined()
    expect(result.reason).toMatch(/invalid|unsupported|decode/i)
    expect(result.reason).not.toContain('private image payload')
    expect(result.reason!.length).toBeLessThan(160)
  })
}

test('drops dangerous declared dimensions without allocating the decoded bitmap', async () => {
  const bytes = Buffer.from(fixture('blue.png', 'image/png').data, 'base64')
  bytes.writeUInt32BE(100000, 16)
  bytes.writeUInt32BE(100000, 20)
  const result = await normalizeImage({
    type: 'image',
    data: bytes.toString('base64'),
    mimeType: 'image/png',
  })
  expect(result.image).toBeUndefined()
  expect(result.reason).toMatch(/large|limit/i)
})

test('a failed decode does not prevent a later valid image from normalizing', async () => {
  await normalizeImage({
    type: 'image',
    data: fixture('blue.png', 'image/png').data.slice(0, 40),
    mimeType: 'image/png',
  })
  const image = fixture('blue.png', 'image/png')
  expect(await normalizeImage(image)).toEqual({ image })
})
