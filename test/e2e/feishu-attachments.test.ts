import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  LanguageModelV4FilePart,
  LanguageModelV4Prompt,
} from '@ai-sdk/provider'
import { z } from 'zod'
import { feishu } from '../../src/extensions/feishu/index.ts'
import type { VelaExtension } from '../../src/index.ts'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { fakeFeishu, feishuEvent, historyMessage } from '../support/feishu.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)
const png = readFileSync(
  new URL('../fixtures/images/blue.png', import.meta.url),
)
const imageParts = (prompt: LanguageModelV4Prompt) =>
  prompt.flatMap((m) =>
    m.role === 'user'
      ? m.content.filter(
          (p): p is LanguageModelV4FilePart =>
            p.type === 'file' && p.mediaType.startsWith('image/'),
        )
      : [],
  )
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out')
    await Bun.sleep(1)
  }
}
async function setup(
  responses = [fauxText('answer')],
  extensions: VelaExtension[] = [],
) {
  const fake = fakeFeishu()
  const t = createTestVela({
    responses,
    allowPendingResponses: true,
    extensions: [
      feishu({
        appId: 'cli_bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
      ...extensions,
    ],
  })
  fake.resources.set('img', [png])
  await t.vela.startChannels()
  return { ...fake, t }
}
const dm = (message_type: string, content: object, message_id = 'attachment') =>
  feishuEvent({
    chat_id: 'oc_dm',
    chat_type: 'p2p',
    mentions: [],
    message_id,
    message_type,
    content: JSON.stringify(content),
  })

test('Feishu DM image-only input reaches the model with sniffed PNG bytes', async () => {
  const f = await setup()
  f.deliver(dm('image', { image_key: 'img' }))
  await until(() => f.sent.length === 1)
  expect(f.t.model.calls).toHaveLength(1)
  expect(imageParts(f.t.model.calls[0]!.prompt)).toHaveLength(1)
  expect(imageParts(f.t.model.calls[0]!.prompt)[0]?.mediaType).toBe('image/png')
  expect(f.resourceCalls).toEqual([
    { messageId: 'attachment', key: 'img', type: 'image' },
  ])
})

test('Feishu rich post with only an img element triggers an image request', async () => {
  const f = await setup()
  f.deliver(
    dm('post', {
      zh_cn: {
        content: [
          [{ tag: 'at', user_id: 'ou_bot' }],
          [{ tag: 'img', image_key: 'img' }],
        ],
      },
    }),
  )
  await until(() => f.sent.length === 1)
  expect(imageParts(f.t.model.calls[0]!.prompt)).toHaveLength(1)
})

test('Feishu group image then @text attaches the four most recent images and does not download historical files', async () => {
  const f = await setup()
  for (let i = 6; i >= 1; i--) {
    f.resources.set(`img${i}`, [png])
    f.history.push({
      ...historyMessage(`image${i}`, 'ou_bob', '', `${1000 + i}`),
      msg_type: 'image',
      body: { content: JSON.stringify({ image_key: `img${i}` }) },
    })
  }
  f.history.push({
    ...historyMessage('file', 'ou_bob', '', '1000'),
    msg_type: 'file',
    body: { content: '{"file_key":"never","file_name":"notes.pdf"}' },
  })
  f.history.push({
    ...historyMessage('boundary', 'cli_bot', 'previous', '900'),
    sender: { id: 'cli_bot', sender_type: 'app' },
  })
  f.deliver(
    feishuEvent({
      message_type: 'image',
      content: '{"image_key":"img6"}',
      mentions: [],
      message_id: 'image6',
    }),
  )
  f.deliver(feishuEvent({ create_time: '2000', message_id: 'question' }))
  await until(() => f.sent.length === 1)
  expect(imageParts(f.t.model.calls[0]!.prompt)).toHaveLength(4)
  expect(f.resourceCalls.map((c) => c.key).sort()).toEqual([
    'img3',
    'img4',
    'img5',
    'img6',
  ])
  expect(f.t.model.calls[0]?.lastUserText).toContain('[file: notes.pdf]')
})

for (const name of ['notes.txt', '../../outside.txt', '..\\..\\outside.txt']) {
  test(`Feishu saves ${name} inside the session files directory and sends its absolute path`, async () => {
    const f = await setup()
    f.resources.set('file', [Buffer.from('hello'), Buffer.from(' world')])
    f.deliver(dm('file', { file_key: 'file', file_name: name }))
    await until(() => f.sent.length === 1)
    const directory = f.t.dataPath('channels/feishu-oc_dm/files')
    const files = readdirSync(directory)
    expect(files).toHaveLength(1)
    const path = join(directory, files[0]!)
    expect(dirname(path)).toBe(directory)
    expect(files[0]).not.toContain('..')
    expect(readFileSync(path, 'utf8')).toBe('hello world')
    expect(f.t.model.calls[0]?.lastUserText).toContain(`saved at ${path}]`)
  })
}

test('Feishu stops a streamed file above 20MB, removes its partial file and replies too large without calling the model', async () => {
  const f = await setup()
  f.resources.set(
    'large',
    Array.from({ length: 22 }, () => Buffer.alloc(1024 * 1024)),
  )
  f.deliver(dm('file', { file_key: 'large', file_name: 'large.bin' }))
  await until(() => f.sent.length === 1)
  expect(f.sent[0]?.text).toMatch(/too large.*20\s*MB/i)
  expect(f.t.model.calls).toHaveLength(0)
  expect(readdirSync(f.t.dataPath('channels/feishu-oc_dm/files'))).toEqual([])
})

test('Feishu refuses an existing symlink file without writing outside the session directory', async () => {
  const f = await setup()
  const directory = f.t.dataPath('channels/feishu-oc_dm/files')
  mkdirSync(directory, { recursive: true })
  const target = join(f.t.cwd, 'outside.txt')
  await Bun.write(target, 'untouched')
  symlinkSync(target, join(directory, 'attachment-notes.txt'))
  f.resources.set('file', [Buffer.from('overwrite')])
  f.deliver(dm('file', { file_key: 'file', file_name: 'notes.txt' }))
  f.deliver(dm('text', { text: 'barrier' }, 'barrier'))
  await until(() => f.t.model.calls.length > 0)
  expect(readFileSync(target, 'utf8')).toBe('untouched')
})

test('Feishu audio stays unsupported and advertises text, images and files', async () => {
  const f = await setup()
  f.deliver(dm('audio', { file_key: 'audio' }))
  await until(() => f.sent.length === 1)
  expect(f.sent[0]?.text).toMatch(/text.*images.*files/)
  expect(f.t.model.calls).toHaveLength(0)
  expect(f.resourceCalls).toEqual([])
})

test('Feishu Steer carries an image into the active run', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await setup(
    [fauxToolCall('hold_pause', {}), fauxText('combined')],
    [
      function hold(api) {
        api.registerTool({
          name: 'pause',
          description: 'Wait',
          inputSchema: z.object({}),
          execute: async () => {
            await held
            return 'released'
          },
        })
      },
    ],
  )
  f.deliver(dm('text', { text: 'start' }, 'start'))
  await until(() => f.t.model.calls.length === 1)
  f.deliver(dm('image', { image_key: 'img' }))
  await until(() => f.cards.length === 1)
  f.click(0, 'steer', { operator: { open_id: 'ou_alice' } })
  const session = f.t.vela.session('feishu-oc_dm')
  await until(() => session.queue.steering.length === 1)
  release()
  await until(() => f.t.model.calls.length === 2)
  expect(imageParts(f.t.model.calls[1]!.prompt)).toHaveLength(1)
})

test('Feishu first file creates a fresh data directory before the first session save', async () => {
  const f = await setup()
  const { rmSync } = await import('node:fs')
  rmSync(f.t.vela.dataDir, { recursive: true, force: true })
  f.resources.set('file', [Buffer.from('first')])
  f.deliver(dm('file', { file_key: 'file', file_name: 'first.txt' }))
  await until(() => f.sent.length === 1)
  expect(
    readFileSync(
      f.t.dataPath('channels/feishu-oc_dm/files/attachment-first.txt'),
      'utf8',
    ),
  ).toBe('first')
})

test('Feishu file prepared by expired Steer is reused when the gateway processes its default queue', async () => {
  const f = await setup()
  f.resources.set('file', [Buffer.from('once')])
  const event = dm('file', { file_key: 'file', file_name: 'once.txt' })
  const { FeishuChannel } = await import(
    '../../src/extensions/feishu/channel.ts'
  )
  const { silentLogger } = await import('../../src/logger.ts')
  const channel = new FeishuChannel({
    appId: '',
    appSecret: '',
    owners: ['ou_alice'],
    dataDir: f.t.vela.dataDir,
    logger: silentLogger,
    transport: f.transport,
  })
  await channel.start()
  const input = {
    channelId: 'oc_dm',
    senderId: 'ou_alice',
    senderName: 'Alice',
    text: '[file: once.txt]',
    raw: event,
  }
  await channel.prepareMessage(input, {
    ...input,
    raw: dm('text', { text: 'active' }, 'active'),
  })
  const queued = await channel.prepareMessage(input)
  expect(queued?.text).toContain('saved at')
  expect(f.resourceCalls).toHaveLength(1)
  await channel.stop()
})
