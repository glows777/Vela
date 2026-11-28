/** Offline tool image, post-hook normalization, text-only fallback and resume. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CreateRuntimeOptions, createRuntime } from '@glows777/vela'
import type { VelaExtension } from '@glows777/vela/extension-api'
import { createFauxModel, fauxText, fauxToolCall } from '@glows777/vela/testing'

const root = await mkdtemp(join(tmpdir(), 'vela-tool-images-'))
const workspace = join(root, 'workspace')
const agentDir = join(root, 'agent')
await mkdir(workspace, { recursive: true })
await mkdir(agentDir, { recursive: true })

const source = process.argv[2]
  ? await readFile(process.argv[2])
  : Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAEUlEQVR4nGNQqTyJFTFQTwIAqbwswWi7rh0AAAAASUVORK5CYII=',
      'base64',
    )
await writeFile(join(workspace, 'picture.txt'), source)

const model = createFauxModel({
  responses: [
    fauxToolCall('read', { path: 'picture.txt' }),
    fauxText('Read the image.'),
    fauxText('Text-only continuation.'),
    fauxText('Restored image.'),
  ],
})
const captions: VelaExtension = (v) => {
  v.on('tool_result', (event) =>
    event.toolName === 'read' && event.content
      ? {
          content: [
            { type: 'text', text: 'An image read from picture.txt' },
            ...event.content,
          ],
        }
      : undefined,
  )
}
const options: CreateRuntimeOptions = {
  agentDir,
  defaultModel: 'demo/vision',
  extensions: [captions],
  mcp: false,
  trustOverride: () => true,
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
const runtime = createRuntime(options)
let restored: ReturnType<typeof createRuntime> | undefined
try {
  await runtime.ready()
  const project = await runtime.projects.create({
    name: 'ToolImages',
    cwd: workspace,
    hubSessionId: true,
  })
  const sessionId = project.hubSessionId!
  await runtime.prompt(sessionId, { text: 'Read picture.txt as an image.' })
  await runtime.waitForIdle(sessionId)

  const page = await runtime.sessions.messages({ sessionId })
  const toolPart = page.messages
    .flatMap((message) =>
      message.role === 'tool' && Array.isArray(message.content)
        ? (message.content as Array<{
            type?: string
            output?: {
              type?: string
              value?: Array<{ type?: string; mimeType?: string; data?: string }>
            }
          }>)
        : [],
    )
    .find((part) => part.type === 'tool_result')?.output
  const image =
    toolPart?.type === 'content'
      ? toolPart.value?.find((part) => part.type === 'image')
      : undefined
  if (!image?.data || !image.mimeType) {
    throw new Error('Tool image missing from canonical history')
  }
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

  await runtime.sessions.setModel(sessionId, 'demo/text')
  await runtime.prompt(sessionId, { text: 'Continue with the text model.' })
  await runtime.waitForIdle(sessionId)
  if (
    !JSON.stringify(model.calls[2]?.prompt).includes(
      '(tool image omitted: model does not support images)',
    )
  )
    throw new Error('Tool fallback missing')
  await runtime.dispose()

  restored = createRuntime(options)
  await restored.ready()
  if (!(await restored.sessions.get(sessionId))) {
    throw new Error('Saved session missing')
  }
  await restored.sessions.setModel(sessionId, 'demo/vision')
  await restored.prompt(sessionId, {
    text: 'View the saved tool image again.',
  })
  await restored.waitForIdle(sessionId)
  if (!JSON.stringify(model.calls[3]?.prompt).includes('"type":"file"'))
    throw new Error('Resumed tool image missing')
  console.log(
    'tool hook, text-only fallback and resumed image request verified',
  )
  console.log('Offline faux responses only; no live visual recognition claim.')
} finally {
  await restored?.dispose()
  await runtime.dispose()
  await rm(root, { recursive: true, force: true })
}
