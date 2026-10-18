import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type FeishuOptions,
  feishu,
} from '../../src/extensions/feishu/index.ts'
import { silentLogger } from '../../src/logger.ts'
import { fileSessionStorage } from '../../src/session/storage.ts'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { fakeFeishu, feishuEvent, historyMessage } from '../support/feishu.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

const roots: string[] = []
afterEach(async () => {
  await cleanupTestVelas()
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Passive message did not settle')
    await Bun.sleep(1)
  }
}
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'vela-passive-'))
  roots.push(path)
  return path
}
function setup(
  options: Parameters<typeof createTestVela>[0] = {},
  chats: FeishuOptions['chats'] = ['oc_group'],
) {
  const fake = fakeFeishu()
  const logs: string[] = []
  const t = createTestVela({
    ...options,
    logger: {
      ...silentLogger,
      info: (line) => logs.push(line),
      warn: (line) => logs.push(line),
      error: (line) => logs.push(line),
    },
    extensions: [
      feishu({
        appId: 'test_app',
        owners: ['ou_alice'],
        chats,
        transport: fake.transport,
      }),
      ...(options?.extensions ?? []),
    ],
  })
  const start = async () => {
    await t.vela.startChannels()
    logs.length = 0
  }
  return { t, fake, logs, start }
}
const passive = (message_id: string, text: string) =>
  feishuEvent({ message_id, mentions: [], content: JSON.stringify({ text }) })

test('default-on intake queues each unique message, skips silently, treats commands as discussion and deduplicates after restart', async () => {
  const cwd = await root()
  let entered = false
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let commands = 0
  const first = setup(
    {
      cwd,
      responses: [
        (req) => {
          expect(req.tools).toContain('feishu_skip_reply')
          return fauxToolCall('feishu_skip_reply', {})
        },
        fauxText('this text must stay silent'),
        fauxText('A useful short answer'),
        (req) => {
          expect(req.lastUserText).toContain('Alice: /danger')
          return fauxToolCall('feishu_skip_reply', {})
        },
        fauxText('also silent'),
        fauxText('explicit while busy'),
      ],
      extensions: [
        (api) => {
          api.registerCommand('danger', {
            description: 'must not execute',
            handler: () => {
              commands++
            },
          })
          api.on('before_agent_start', async () => {
            if (!entered) {
              entered = true
              await held
            }
          })
        },
      ],
    },
    [{ id: 'oc_group', tools: [] }],
  )
  await first.start()
  try {
    first.fake.deliver(passive('quiet', 'colleagues discussing lunch'))
    await until(() => entered)
    first.fake.deliver(passive('quiet', 'colleagues discussing lunch'))
    first.fake.deliver(passive('answer', 'a useful short question'))
    first.fake.deliver(passive('command', '/danger'))
    first.fake.deliver(feishuEvent({ message_id: 'explicit-busy' }))
  } finally {
    release()
  }
  await until(() => first.t.model.calls.length === 6)
  await first.t.internals.gateway.stopAll()
  expect(first.fake.sent).toEqual([
    { messageId: 'answer', text: 'A useful short answer' },
    { messageId: 'explicit-busy', text: 'explicit while busy' },
  ])
  expect(first.fake.cards).toEqual([])
  expect(
    first.fake.reactions.every((item) => item.messageId === 'explicit-busy'),
  ).toBe(true)
  expect(first.fake.historyCalls).toHaveLength(1)
  expect(commands).toBe(0)
  expect(first.t.events.filter((e) => e.type === 'channel_reply')).toHaveLength(
    2,
  )
  const stored = await first.t.readData('sessions/feishu-oc_group.jsonl')
  expect(stored).toContain('Alice: colleagues discussing lunch')
  expect(stored).toContain('feishu_skip_reply')
  expect(stored).toContain('"passive":true')
  await first.t.cleanup({ keepDir: true })
  const second = setup({ cwd, responses: [fauxText('new input only')] })
  await second.start()
  for (const id of ['quiet', 'answer', 'command'])
    second.fake.deliver(passive(id, 'duplicate'))
  second.fake.deliver(passive('fresh', 'new question'))
  await until(() => second.fake.sent.length > 0)
  await second.t.internals.gateway.stopAll()
  expect(second.t.model.calls).toHaveLength(1)
  expect(second.fake.sent).toEqual([
    { messageId: 'fresh', text: 'new input only' },
  ])
})

test('off, disabled groups, self and other bots, and unsupported passive messages have no content side effects', async () => {
  const run = setup({ responses: [fauxText('explicit answer')] }, [
    { id: 'oc_group', readUntagged: false },
    'oc_on',
  ])
  await run.start()
  run.fake.deliver(passive('off', 'not admitted'))
  const disabled = passive('disabled', 'private discussion')
  disabled.message.chat_id = 'oc_disabled'
  Object.defineProperty(disabled.message, 'content', {
    get() {
      throw new Error('Disabled content was parsed')
    },
  })
  run.fake.deliver(disabled)
  for (const sender of ['ou_bot', 'ou_other_bot']) {
    const event = feishuEvent({ chat_id: 'oc_on' }, sender)
    Object.assign(event.sender, { sender_type: 'bot' })
    run.fake.deliver(event)
  }
  run.fake.deliver(
    feishuEvent({
      chat_id: 'oc_on',
      mentions: [],
      message_type: 'audio',
      content: '{}',
    }),
  )
  run.fake.deliver(feishuEvent({ message_id: 'explicit' }))
  await until(() => run.fake.sent.length > 0)
  await run.t.internals.gateway.stopAll()
  expect(run.t.model.calls).toHaveLength(1)
  expect(run.fake.sent).toEqual([
    { messageId: 'explicit', text: 'explicit answer' },
  ])
  expect(run.logs.join('\n')).not.toContain('oc_disabled')
  expect(run.logs.join('\n')).not.toContain('private discussion')
  expect(run.fake.nameCalls).toEqual(['ou_alice'])
  expect(run.fake.resourceCalls).toEqual([])
  expect(
    existsSync(join(run.t.vela.dataDir, 'channels', 'feishu-oc_disabled')),
  ).toBe(false)
  expect(
    existsSync(join(run.t.vela.dataDir, 'sessions', 'feishu-oc_on.jsonl')),
  ).toBe(false)
})

test('supported passive files use the existing attachment store and preparation failures stay operator-only', async () => {
  const run = setup({
    responses: [
      (req) => {
        expect(req.lastUserText).toContain('brief.txt')
        return fauxToolCall('feishu_skip_reply', {})
      },
      fauxText('silent'),
    ],
  })
  run.fake.resources.set('brief', [Buffer.from('shared brief')])
  await run.start()
  run.fake.deliver(
    feishuEvent({
      message_id: 'file',
      mentions: [],
      message_type: 'file',
      content: '{"file_key":"brief","file_name":"brief.txt"}',
    }),
  )
  await until(() => run.t.model.calls.length === 2)
  run.fake.deliver(
    feishuEvent({
      message_id: 'bad-file',
      mentions: [],
      message_type: 'file',
      content: '{"file_key":"missing","file_name":"missing.txt"}',
    }),
  )
  await until(() => run.fake.resourceCalls.length === 2)
  await run.t.internals.gateway.stopAll()
  expect(run.fake.sent).toEqual([])
  expect(run.fake.reactions).toEqual([])
  expect(run.fake.cards).toEqual([])
  expect(run.logs.join('\n')).toContain('missing')
  expect(run.t.model.calls).toHaveLength(2)
})

test('a top-level card answer is a history boundary after process restart regardless of message type', async () => {
  const cwd = await root()
  const first = setup({ cwd, responses: [fauxText('first answer')] }, [
    { id: 'oc_group', readUntagged: false },
  ])
  // Emulate Feishu rendering the delivered answer as an interactive card in history.
  first.fake.transport.reply = async (messageId, text) => {
    await first.fake.transport.sendCard(
      'oc_group',
      {
        schema: '2.0',
        header: { title: { tag: 'plain_text', content: 'Answer' } },
        body: { elements: [] },
      },
      messageId,
    )
    first.fake.sent.push({ messageId, text })
    return { messageId: 'own-card', createTime: '2000' }
  }
  await first.start()
  first.fake.deliver(feishuEvent({ message_id: 'first', create_time: '1500' }))
  await until(() => first.fake.sent.length > 0)
  await first.t.cleanup({ keepDir: true })
  const second = setup(
    {
      cwd,
      responses: [
        (req) => {
          expect(req.lastUserText).toContain('after the answer')
          expect(req.lastUserText).not.toContain('already answered discussion')
          return fauxText('second answer')
        },
      ],
    },
    [{ id: 'oc_group', readUntagged: false }],
  )
  second.fake.history.push(
    historyMessage('new', 'ou_bob', 'after the answer', '3000'),
    {
      message_id: 'own-card',
      create_time: '2000',
      msg_type: 'interactive',
      sender: { id: 'test_app', sender_type: 'app' },
      body: { content: '{}' },
    },
    historyMessage('old', 'ou_bob', 'already answered discussion', '1000'),
  )
  await second.start()
  second.fake.deliver(
    feishuEvent({ message_id: 'second', create_time: '4000' }),
  )
  await until(() => second.fake.sent.length > 0)
  expect(second.fake.sent.at(-1)?.text).toBe('second answer')
})

test('a passive session blocked by repeated storage failures stays operator-only', async () => {
  const cwd = await root()
  const storage = fileSessionStorage(join(cwd, 'sessions'))
  let failing = true
  const run = setup({
    cwd,
    responses: [fauxText('one'), fauxText('two'), fauxText('three')],
    sessionStorage: {
      ...storage,
      append: async (...args) => {
        if (failing) throw new Error('disk full')
        await storage.append(...args)
      },
    },
  })
  await run.start()
  try {
    for (const id of ['first', 'second', 'third', 'blocked'])
      run.fake.deliver(passive(id, id))
    await until(
      () =>
        run.fake.sent.some((item) => item.text.includes("can't be saved")) ||
        run.logs.some((line) => line.includes('Passive evaluation paused')),
    )
    // The channel's stop waits for all accepted queue entries and operator diagnostics.
    await run.t.internals.gateway.stopAll()
    expect(run.t.model.calls).toHaveLength(3)
    expect(run.fake.sent).toEqual([])
    expect(run.logs.join('\n')).toContain('disk full')
  } finally {
    failing = false
  }
})
