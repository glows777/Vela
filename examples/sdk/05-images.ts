/** Offline image prompt, text-only fallback, and persistence. Optional first argument: an image path. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVela, type ImageContent } from '@glows777/vela'
import { createFauxModel, fauxText } from '@glows777/vela/testing'

const dataDir = await mkdtemp(join(tmpdir(), 'vela-image-example-'))
const image: ImageContent = {
  type: 'image',
  data: process.argv[2]
    ? (await readFile(process.argv[2])).toString('base64')
    : 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAEUlEQVR4nGNQqTyJFTFQTwIAqbwswWi7rh0AAAAASUVORK5CYII=',
  mimeType: 'image/png', // Vela detects the actual format from the bytes.
}
const model = createFauxModel({
  responses: [
    fauxText('Received image.'),
    fauxText('Text-only reply.'),
    fauxText('Image restored.'),
  ],
})
const providers = {
  demo: {
    models: [
      { id: 'vision', input: ['text', 'image'] },
      { id: 'text', input: ['text'] },
    ],
    createModel: () => model,
  },
}
const options = { model: 'demo/vision', providers, dataDir }
const vela = createVela(options)
let resumed: ReturnType<typeof createVela> | undefined
try {
  const session = vela.session('images')
  await session.prompt('Describe this picture.', { images: [image] })
  const content = session.messages[0]?.content
  const saved =
    typeof content === 'string'
      ? undefined
      : content?.find((part) => part.type === 'image' && 'data' in part)
  if (!saved || !('data' in saved))
    throw new Error('Image did not enter history')
  console.log(
    JSON.stringify({
      event: 'saved_image',
      mimeType: saved.mimeType,
      base64Bytes: saved.data.length,
      resized: saved.data !== image.data,
    }),
  )
  session.setModel('demo/text')
  await session.prompt('Continue with the text model.')
  if (
    !model.calls[1]?.lastUserText ||
    !JSON.stringify(model.calls[1].prompt).includes(
      '(image omitted: model does not support images)',
    )
  )
    throw new Error('Text-only fallback missing')
  console.log('text-only fallback verified; saved image retained')
  await vela.dispose()
  resumed = createVela(options)
  const again = resumed.session('images')
  if (!(await again.resume())) throw new Error('Saved session missing')
  again.setModel('demo/vision')
  await again.prompt('Look at the saved image again.')
  const files =
    model.calls[2]?.prompt.flatMap((m) =>
      m.role === 'user'
        ? m.content.filter(
            (p) => p.type === 'file' && p.mediaType.startsWith('image/'),
          )
        : [],
    ) ?? []
  if (files.length !== 1)
    throw new Error('Resumed image did not reach the model')
  console.log('resume and vision model request verified')
  console.log(
    'Offline faux provider only; no claim about image recognition quality.',
  )
} finally {
  await resumed?.dispose()
  await vela.dispose()
  await rm(dataDir, { recursive: true, force: true })
}
