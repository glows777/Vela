import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  LanguageModelV4FilePart,
  LanguageModelV4Prompt,
} from '@ai-sdk/provider'
import type { VelaExtension } from '@glows777/vela'
import { fauxError, fauxText, fauxToolCall } from '@glows777/vela-core/testing'
import { lark } from '@glows777/vela-lark'
import { z } from 'zod'
import { fakeLark, historyMessage, larkEvent } from '../support/lark.ts'
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
  readUntagged = true,
) {
  const fake = fakeLark()
  const t = createTestVela({
    responses,
    allowPendingResponses: true,
    extensions: [
      lark({
        appId: 'cli_bot',
        owners: ['ou_alice'],
        chats: [{ id: 'oc_group', readUntagged }],
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
  larkEvent({
    chat_id: 'oc_dm',
    chat_type: 'p2p',
    mentions: [],
    message_id,
    message_type,
    content: JSON.stringify(content),
  })

test('Lark DM image-only input reaches the model with sniffed PNG bytes', async () => {
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

test('Lark rich post with only an img element triggers an image request', async () => {
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

test('with passive intake off, group image then @text attaches four recent images without downloading historical files', async () => {
  const f = await setup(undefined, [], false)
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
    larkEvent({
      message_type: 'image',
      content: '{"image_key":"img6"}',
      mentions: [],
      message_id: 'image6',
    }),
  )
  f.deliver(larkEvent({ create_time: '2000', message_id: 'question' }))
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
  test(`Lark saves ${name} inside the session files directory and sends its absolute path`, async () => {
    const f = await setup()
    f.resources.set('file', [Buffer.from('hello'), Buffer.from(' world')])
    f.deliver(dm('file', { file_key: 'file', file_name: name }))
    await until(() => f.sent.length === 1)
    const directory = f.t.dataPath('channels/lark-oc_dm/files')
    const files = readdirSync(directory)
    expect(files).toHaveLength(1)
    const path = join(directory, files[0]!)
    expect(dirname(path)).toBe(directory)
    expect(files[0]).not.toContain('..')
    expect(readFileSync(path, 'utf8')).toBe('hello world')
    expect(f.t.model.calls[0]?.lastUserText).toContain(`saved at ${path}]`)
  })
}

test('Lark stops a streamed file above 20MB, removes its partial file and replies too large without calling the model', async () => {
  const f = await setup()
  f.resources.set(
    'large',
    Array.from({ length: 22 }, () => Buffer.alloc(1024 * 1024)),
  )
  f.deliver(dm('file', { file_key: 'large', file_name: 'large.bin' }))
  await until(() => f.sent.length === 1)
  expect(f.sent[0]?.text).toMatch(/too large.*20\s*MB/i)
  expect(f.t.model.calls).toHaveLength(0)
  expect(readdirSync(f.t.dataPath('channels/lark-oc_dm/files'))).toEqual([])
})

test('Lark refuses an existing symlink file without writing outside the session directory', async () => {
  const f = await setup()
  const directory = f.t.dataPath('channels/lark-oc_dm/files')
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

test('Lark audio stays unsupported and advertises text, images and files', async () => {
  const f = await setup()
  f.deliver(dm('audio', { file_key: 'audio' }))
  await until(() => f.sent.length === 1)
  expect(f.sent[0]?.text).toMatch(/text.*images.*files/)
  expect(f.t.model.calls).toHaveLength(0)
  expect(f.resourceCalls).toEqual([])
})

test('Lark Steer carries an image into the active run', async () => {
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
  const session = f.t.vela.session('lark-oc_dm')
  await until(() => session.queue.steering.length === 1)
  release()
  await until(() => f.t.model.calls.length === 2)
  expect(imageParts(f.t.model.calls[1]!.prompt)).toHaveLength(1)
})

test('Lark first file creates a fresh data directory before the first session save', async () => {
  const f = await setup()
  const { rmSync } = await import('node:fs')
  rmSync(f.t.vela.dataDir, { recursive: true, force: true })
  f.resources.set('file', [Buffer.from('first')])
  f.deliver(dm('file', { file_key: 'file', file_name: 'first.txt' }))
  await until(() => f.sent.length === 1)
  expect(
    readFileSync(
      f.t.dataPath('channels/lark-oc_dm/files/attachment-first.txt'),
      'utf8',
    ),
  ).toBe('first')
})

test('Lark file prepared by expired Steer is reused when the gateway processes its default queue', async () => {
  const f = await setup()
  f.resources.set('file', [Buffer.from('once')])
  const event = dm('file', { file_key: 'file', file_name: 'once.txt' })
  const { LarkChannel } = await import('../../packages/lark/src/channel.ts')
  const { silentLogger } = await import('../../packages/core/src/logger.ts')
  const channel = new LarkChannel({
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

for (const type of ['image', 'file']) {
  test(`Lark ${type} download failure replies with the error and resource permission hint`, async () => {
    const f = await setup()
    f.transport.getResource = async () => {
      throw new Error('99991672: Access denied; im:resource required')
    }
    f.deliver(
      dm(type, { image_key: 'img', file_key: 'file', file_name: 'notes.txt' }),
    )
    f.deliver(dm('text', { text: 'barrier' }, 'barrier'))
    await until(() => f.t.model.calls.length === 1 && f.sent.length > 0)
    expect(f.sent[0]?.text).toContain(`Couldn't download the ${type}`)
    expect(f.sent[0]?.text).toContain('99991672')
    expect(f.sent[0]?.text).toContain('im:resource')
  })
}

test('Lark interrupted file stream reports failure and leaves no reusable partial file', async () => {
  const f = await setup()
  const { Readable } = await import('node:stream')
  f.transport.getResource = async () =>
    Readable.from(
      (async function* () {
        yield Buffer.from('partial')
        throw new Error('connection reset')
      })(),
    )
  f.deliver(dm('file', { file_key: 'file', file_name: 'notes.txt' }))
  f.deliver(dm('text', { text: 'barrier' }, 'barrier'))
  await until(() => f.t.model.calls.length === 1 && f.sent.length > 0)
  expect(f.sent[0]?.text).toContain('connection reset')
  expect(readdirSync(f.t.dataPath('channels/lark-oc_dm/files'))).toEqual([])
})

test('Lark redelivery after process restart reuses the completed regular file', async () => {
  const f = await setup()
  f.resources.set('file', [Buffer.from('complete')])
  const event = dm('file', { file_key: 'file', file_name: 'notes.txt' })
  f.deliver(event)
  await until(() => f.sent.length === 1)
  await f.t.vela.dispose()
  const next = createTestVela({
    cwd: f.t.cwd,
    dataDir: f.t.vela.dataDir,
    responses: [fauxText('replayed')],
    extensions: [lark({ owners: ['ou_alice'], transport: f.transport })],
  })
  await next.vela.startChannels()
  f.deliver(event)
  await until(() => f.sent.length === 2)
  expect(next.model.calls[0]?.lastUserText).toContain('attachment-notes.txt')
  expect(f.resourceCalls).toHaveLength(1)
  expect(
    readFileSync(
      f.t.dataPath('channels/lark-oc_dm/files/attachment-notes.txt'),
      'utf8',
    ),
  ).toBe('complete')
  await next.vela.dispose()
})

for (const name of [
  `${'a'.repeat(230)}.pdf`,
  `${'报'.repeat(80)}.pdf`,
  'report: Q3?*"<>|.pdf. ',
]) {
  test(`Lark saves a portable bounded filename for ${name.slice(0, 25)}`, async () => {
    const f = await setup()
    f.resources.set('file', [Buffer.from('report')])
    f.deliver(
      dm(
        'file',
        { file_key: 'file', file_name: name },
        'om_12345678901234567890123456789012',
      ),
    )
    await until(() => f.sent.length === 1)
    expect(f.t.model.calls).toHaveLength(1)
    const directory = f.t.dataPath('channels/lark-oc_dm/files')
    const saved = readdirSync(directory)[0]!
    expect(Buffer.byteLength(saved)).toBeLessThanOrEqual(255)
    expect(saved).not.toMatch(/[:?*"<>|]|[. ]$/)
    expect(saved).toEndWith('.pdf')
    expect(readFileSync(join(directory, saved), 'utf8')).toBe('report')
    expect(f.t.model.calls[0]?.lastUserText).toContain(join(directory, saved))
  })
}

test('Lark exposes the reusable file only after the stream completes', async () => {
  const f = await setup()
  const { Readable } = await import('node:stream')
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const streaming = new Promise<void>((r) => {
    entered = r
  })
  f.transport.getResource = async () =>
    Readable.from(
      (async function* () {
        yield Buffer.from('first')
        entered()
        await gate
        yield Buffer.from('last')
      })(),
    )
  f.deliver(dm('file', { file_key: 'file', file_name: 'notes.txt' }))
  await streaming
  try {
    expect(f.t.exists('channels/lark-oc_dm/files/attachment-notes.txt')).toBe(
      false,
    )
  } finally {
    release()
  }
  await until(() => f.sent.length === 1)
  expect(
    readFileSync(
      f.t.dataPath('channels/lark-oc_dm/files/attachment-notes.txt'),
      'utf8',
    ),
  ).toBe('firstlast')
})

test('Lark expired Steer reuses downloaded images when the default queue runs', async () => {
  let finish!: () => void
  const held = new Promise<void>((r) => {
    finish = r
  })
  const f = await setup(
    [
      fauxToolCall('hold_pause', {}),
      fauxText('first answer'),
      fauxText('image answer'),
    ],
    [
      function hold(api) {
        api.registerTool({
          name: 'pause',
          description: 'Wait',
          inputSchema: z.object({}),
          execute: async () => {
            await held
            return 'done'
          },
        })
      },
    ],
  )
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const downloading = new Promise<void>((r) => {
    entered = r
  })
  const resource = f.transport.getResource
  f.transport.getResource = async (...args) => {
    entered()
    await gate
    return resource(...args)
  }
  try {
    f.deliver(dm('text', { text: 'start' }, 'start'))
    await until(() => f.t.model.calls.length === 1)
    f.deliver(dm('image', { image_key: 'img' }))
    await until(() => f.cards.length === 1)
    f.click(0, 'steer', { operator: { open_id: 'ou_alice' } })
    await downloading
    finish()
    await until(() => f.sent.length === 1)
    release()
    await until(() => f.sent.length === 2)
    expect(f.resourceCalls).toHaveLength(1)
    expect(imageParts(f.t.model.calls[2]!.prompt)).toHaveLength(1)
  } finally {
    finish()
    release()
  }
})

test('Lark filename truncation does not expose a trailing space', async () => {
  const f = await setup()
  f.resources.set('file', [Buffer.from('report')])
  f.deliver(
    dm('file', {
      file_key: 'file',
      file_name: `${'a'.repeat(243)} ${'b'.repeat(10)}`,
    }),
  )
  await until(() => f.sent.length === 1)
  expect(readdirSync(f.t.dataPath('channels/lark-oc_dm/files'))[0]).not.toMatch(
    /[. ]$/,
  )
})

test('Lark expired group Steer reuses history images after the active run fails without a reply', async () => {
  let finish!: () => void
  const held = new Promise<void>((r) => {
    finish = r
  })
  const f = await setup(
    [
      fauxToolCall('hold_pause', {}),
      fauxError('400 provider unavailable'),
      fauxText('image answer'),
    ],
    [
      function hold(api) {
        api.registerTool({
          name: 'pause',
          description: 'Wait',
          inputSchema: z.object({}),
          execute: async () => {
            await held
            return 'done'
          },
        })
      },
    ],
  )
  const reply = f.transport.reply
  f.transport.reply = async (messageId, text) => {
    if (messageId === 'start')
      throw new Error('Failure notification unavailable')
    return reply(messageId, text)
  }
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const downloading = new Promise<void>((r) => {
    entered = r
  })
  const resource = f.transport.getResource
  f.transport.getResource = async (...args) => {
    entered()
    await gate
    return resource(...args)
  }
  try {
    f.deliver(larkEvent({ message_id: 'start', create_time: '3000' }))
    await until(() => f.t.model.calls.length === 1)
    f.history.push({
      ...historyMessage('image', 'ou_bob', '', '4000'),
      msg_type: 'image',
      body: { content: '{"image_key":"img"}' },
    })
    f.deliver(larkEvent({ message_id: 'question', create_time: '5000' }))
    await until(() => f.cards.length === 1)
    f.click(0, 'steer')
    await downloading
    finish()
    await until(() => !f.t.vela.session('lark-oc_group').isRunning)
    expect(f.sent).toHaveLength(0)
    release()
    await until(() => f.sent.length === 1)
    expect(f.resourceCalls).toHaveLength(1)
    expect(imageParts(f.t.model.calls[2]!.prompt)).toHaveLength(1)
  } finally {
    finish()
    release()
  }
})
