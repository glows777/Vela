/** Offline image prompt, text-only fallback, and persistence. Optional first argument: an image path. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CreateRuntimeOptions, createRuntime } from '@glows777/vela'
import { createFauxModel, fauxText } from '@glows777/vela/testing'

const agentDir = await mkdtemp(join(tmpdir(), 'vela-image-example-'))
const rawBytes = process.argv[2]
  ? await readFile(process.argv[2])
  : Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAEUlEQVR4nGNQqTyJFTFQTwIAqbwswWi7rh0AAAAASUVORK5CYII=',
      'base64',
    )
const model = createFauxModel({
  responses: [
    fauxText('Received image.'),
    fauxText('Text-only reply.'),
    fauxText('Image restored.'),
  ],
})
const providers: CreateRuntimeOptions['providers'] = {
  demo: {
    models: [
      { id: 'vision', input: ['text', 'image'] },
      { id: 'text', input: ['text'] },
    ],
    createModel: () => model,
  },
}
const options: CreateRuntimeOptions = {
  agentDir,
  defaultModel: 'demo/vision',
  providers,
  mcp: false,
}
const runtime = createRuntime(options)
let resumed: ReturnType<typeof createRuntime> | undefined
try {
  await runtime.ready()
  const session = await runtime.sessions.create({
    id: 'images',
    name: 'Images',
  })
  const blob = await runtime.blobs.storeInbound({
    sessionId: session.id,
    filename: 'picture.png',
    mimeType: 'image/png',
    bytes: new Uint8Array(rawBytes),
  })
  await runtime.prompt(session.id, {
    text: 'Describe this picture.',
    attachments: [
      {
        blobId: blob.id,
        name: 'picture.png',
        mimeType: 'image/png',
        inlineOnly: true,
      },
    ],
  })
  await runtime.waitForIdle(session.id)

  const page = await runtime.sessions.messages({ sessionId: session.id })
  const content = page.messages[0]?.content
  const saved = Array.isArray(content)
    ? (content.find(
        (part): part is { type: 'image'; mimeType: string; data: string } =>
          typeof part === 'object' &&
          part !== null &&
          (part as { type?: unknown }).type === 'image' &&
          'data' in part,
      ) ?? undefined)
    : undefined
  if (!saved) throw new Error('Image did not enter history')
  console.log(
    JSON.stringify({
      event: 'saved_image',
      mimeType: saved.mimeType,
      base64Bytes: saved.data.length,
      resized: saved.data !== rawBytes.toString('base64'),
    }),
  )

  await runtime.sessions.setModel(session.id, 'demo/text')
  await runtime.prompt(session.id, { text: 'Continue with the text model.' })
  await runtime.waitForIdle(session.id)
  if (
    !model.calls[1]?.lastUserText ||
    !JSON.stringify(model.calls[1].prompt).includes(
      '(image omitted: model does not support images)',
    )
  )
    throw new Error('Text-only fallback missing')
  console.log('text-only fallback verified; saved image retained')
  await runtime.dispose()

  resumed = createRuntime(options)
  await resumed.ready()
  if (!(await resumed.sessions.get('images'))) {
    throw new Error('Saved session missing')
  }
  await resumed.sessions.setModel('images', 'demo/vision')
  await resumed.prompt('images', { text: 'Look at the saved image again.' })
  await resumed.waitForIdle('images')
  const files =
    model.calls[2]?.prompt.flatMap((m) =>
      m.role === 'user'
        ? m.content.filter(
            (p: { type: string; mediaType?: string }) =>
              p.type === 'file' && p.mediaType?.startsWith('image/'),
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
  await runtime.dispose()
  await rm(agentDir, { recursive: true, force: true })
}
