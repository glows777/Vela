/** Offline tool image, post-hook normalization, text-only fallback and resume. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVela, type VelaExtension } from '@glows777/vela'
import { createFauxModel, fauxText, fauxToolCall } from '@glows777/vela/testing'

const root = await mkdtemp(join(tmpdir(), 'vela-tool-images-'))
const source = process.argv[2]
  ? await readFile(process.argv[2])
  : Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAEUlEQVR4nGNQqTyJFTFQTwIAqbwswWi7rh0AAAAASUVORK5CYII=',
      'base64',
    )
await writeFile(join(root, 'picture.txt'), source)
const model = createFauxModel({
  responses: [
    fauxToolCall('read_file', { path: 'picture.txt' }),
    fauxText('Read the image.'),
    fauxText('Text-only continuation.'),
    fauxText('Restored image.'),
  ],
})
const captions: VelaExtension = (v) => {
  v.on('tool_result', (event) =>
    event.toolName === 'read_file' && event.content
      ? {
          content: [
            { type: 'text', text: 'An image read from picture.txt' },
            ...event.content,
          ],
        }
      : undefined,
  )
}
const options = {
  cwd: root,
  dataDir: join(root, 'data'),
  model: 'demo/vision',
  extensions: [captions],
  providers: {
    demo: {
      models: [
        { id: 'vision', input: ['text', 'image'] },
        { id: 'text', input: ['text'] },
      ],
      createModel: () => model,
    },
  },
}
const vela = createVela(options)
let restored: ReturnType<typeof createVela> | undefined
try {
  const session = vela.session('tools')
  await session.prompt('Read picture.txt as an image.')
  const output = session.messages
    .flatMap((message) => (message.role === 'tool' ? message.content : []))
    .find((part) => part.type === 'tool-result')?.output
  const image =
    output?.type === 'content'
      ? output.value.find((part) => part.type === 'image')
      : undefined
  if (!image) throw new Error('Tool image missing from canonical history')
  console.log(
    JSON.stringify({
      event: 'tool_image',
      mimeType: image.mimeType,
      base64Bytes: image.data.length,
      changed: image.data !== source.toString('base64'),
    }),
  )
  const request = JSON.stringify(model.calls[1]?.prompt)
  if (
    !request.includes('An image read from picture.txt') ||
    !request.includes('"type":"file"')
  )
    throw new Error('Tool caption/image missing from request')
  session.setModel('demo/text')
  await session.prompt('Continue with the text model.')
  if (
    !JSON.stringify(model.calls[2]?.prompt).includes(
      '(tool image omitted: model does not support images)',
    )
  )
    throw new Error('Tool fallback missing')
  await vela.dispose()
  restored = createVela(options)
  const again = restored.session('tools')
  if (!(await again.resume())) throw new Error('Saved session missing')
  again.setModel('demo/vision')
  await again.prompt('View the saved tool image again.')
  if (!JSON.stringify(model.calls[3]?.prompt).includes('"type":"file"'))
    throw new Error('Resumed tool image missing')
  console.log(
    'tool hook, text-only fallback and resumed image request verified',
  )
  console.log('Offline faux responses only; no live visual recognition claim.')
} finally {
  await restored?.dispose()
  await vela.dispose()
  await rm(root, { recursive: true, force: true })
}
