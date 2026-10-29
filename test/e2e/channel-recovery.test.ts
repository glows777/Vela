import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { silentLogger } from '@glows777/vela-core'
import {
  fauxError,
  fauxHang,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'
import { lark } from '@glows777/vela-lark'
import { fakeLark, larkEvent } from '../support/lark.ts'
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
    if (Date.now() > deadline) throw new Error('Recovery did not finish')
    await Bun.sleep(1)
  }
}
async function root() {
  const cwd = await mkdtemp(join(tmpdir(), 'vela-recovery-'))
  roots.push(cwd)
  return cwd
}
async function crash(mode: string) {
  const cwd = await root()
  const child = Bun.spawn(
    [
      process.execPath,
      new URL('../fixtures/channels/crash.ts', import.meta.url).pathname,
      cwd,
      mode,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  try {
    const reader = child.stdout.getReader()
    const timer = setTimeout(() => child.kill(), 5000)
    let output = ''
    try {
      while (!output.includes('CRASH_READY')) {
        const next = await reader.read()
        if (next.done)
          throw new Error(
            `Crash fixture exited: ${await new Response(child.stderr).text()}`,
          )
        output += new TextDecoder().decode(next.value)
      }
    } finally {
      clearTimeout(timer)
      reader.releaseLock()
    }
  } finally {
    child.kill('SIGKILL')
    await child.exited
  }
  return cwd
}
function setup(
  cwd: string,
  responses: NonNullable<
    Parameters<typeof createTestVela>[0]
  >['responses'] = [],
  chats = ['oc_group'],
) {
  const fake = fakeLark()
  const t = createTestVela({
    cwd,
    responses,
    extensions: [
      lark({ owners: ['ou_alice'], chats, transport: fake.transport }),
    ],
  })
  const start = async () => {
    await t.vela.ready()
    await t.vela.startChannels()
  }
  return { fake, t, start }
}

test('a killed process resumes its saved unanswered user through topic feedback without another event', async () => {
  const cwd = await crash('saved')
  const { fake, t, start } = setup(cwd, [fauxText('recovered cobalt')])
  await start()
  await until(() => fake.sent.some((m) => m.text.includes('recovered cobalt')))
  expect(fake.sent[0]).toMatchObject({
    messageId: 'trigger',
    text: expect.stringContaining('interrupted'),
  })
  expect(fake.sent.at(-1)?.text).toContain('ou_alice')
  expect(t.model.calls).toHaveLength(1)
  expect(t.model.calls[0]?.lastUserText).toContain('remember cobalt')
  expect(fake.cards).toHaveLength(1)
  expect(fake.topicHistoryCalls).toEqual([])
  expect(fake.nameCalls).toEqual([])
  const users = t.vela
    .session('lark-oc_group-root')
    .getBranch()
    .filter((e) => e.type === 'message' && e.message.role === 'user')
  expect(users).toHaveLength(1)
})

test('admitted input killed before append gets a message-targeted resend notice and no model call', async () => {
  const cwd = await crash('before-append')
  const { fake, t, start } = setup(cwd)
  await start()
  await until(() => fake.sent.length > 0)
  expect(fake.sent).toEqual([
    { messageId: 'trigger', text: expect.stringContaining('send it again') },
  ])
  expect(t.model.calls).toEqual([])
})

test('a running record with a saved final answer delivers that answer without rerunning the model', async () => {
  const cwd = await crash('answer')
  const { fake, t, start } = setup(cwd)
  await start()
  await until(() => fake.sent.length > 0)
  expect(fake.sent).toEqual([
    { messageId: 'trigger', text: expect.stringContaining('saved answer') },
  ])
  expect(t.model.calls).toEqual([])
})

test('a hand-off note interrupted mid-run reruns after restart and the previous answer is not reposted', async () => {
  const cwd = await crash('note')
  const { fake, t, start } = setup(cwd, [
    (req) =>
      fauxText(
        req.lastUserText.includes('cobalt is ready')
          ? 'cobalt confirmed'
          : 'unexpected',
      ),
  ])
  await start()
  await until(() => fake.sent.some((m) => m.text.includes('cobalt confirmed')))
  expect(fake.sent.map((m) => m.text)).toEqual([
    expect.stringContaining('interrupted'),
    expect.stringContaining('cobalt confirmed'),
  ])
  expect(fake.sent[1]?.messageId).toBe('root')
  expect(t.model.calls).toHaveLength(1)
})

test('a hand-off note killed before it reached the session is dropped without reposting the previous answer', async () => {
  const cwd = await crash('note-early')
  const { fake, t, start } = setup(cwd)
  await start()
  await until(() =>
    JSON.parse(
      readFileSync(join(t.vela.dataDir, 'channels/index.json'), 'utf8'),
    ).records.every((record: { state: string }) => record.state !== 'running'),
  )
  await Bun.sleep(50)
  expect(fake.sent).toEqual([])
  expect(t.model.calls).toEqual([])
})

test('completed topics survive restart and a top-level follow-up forwards to the existing thread', async () => {
  const cwd = await root()
  const first = setup(cwd, [fauxText('cobalt done')])
  await first.start()
  first.fake.deliver(larkEvent({ root_id: 'root', thread_id: 'thread' }))
  await until(() => first.fake.sent.length > 0)
  await first.t.cleanup({ keepDir: true })
  const second = setup(cwd, [
    fauxToolCall('lark_list_topics', {}),
    (req) => {
      expect(JSON.stringify(req.toolResults)).toContain('thread')
      return fauxToolCall('lark_forward_to_topic', { root_id: 'root' })
    },
    (req) =>
      fauxText(
        req.tools.includes('lark_start_topic')
          ? 'forwarded'
          : 'follow-up answer',
      ),
    (req) =>
      fauxText(
        req.tools.includes('lark_start_topic')
          ? 'forwarded'
          : 'follow-up answer',
      ),
  ])
  await second.start()
  expect(second.fake.sent).toEqual([])
  expect(second.t.model.calls).toEqual([])
  second.fake.deliver(
    larkEvent({
      message_id: 'followup',
      content: '{"text":"continue cobalt"}',
    }),
  )
  await until(() =>
    second.fake.sent.some((m) => m.text.includes('follow-up answer')),
  )
  expect(second.fake.topics).toEqual([])
  expect(second.fake.forwards).toEqual([
    { messageId: 'followup', threadId: 'thread' },
  ])
})

test('Stop is durable and a restart does not revive the cancelled topic', async () => {
  const cwd = await root()
  const first = setup(cwd, [fauxHang()])
  await first.start()
  first.fake.deliver(larkEvent({ root_id: 'root', thread_id: 'thread' }))
  await until(() => first.t.model.calls.length > 0)
  first.fake.click(0, 'stop')
  await until(() => first.fake.sent.some((m) => m.text.includes('Stopped')))
  await first.t.cleanup({ keepDir: true })
  const second = setup(cwd)
  await second.start()
  expect(second.fake.sent).toEqual([])
  expect(second.t.model.calls).toEqual([])
})

test('unowned untagged input writes neither a directory nor a session and produces no feedback', async () => {
  const cwd = await root()
  const { fake, t, start } = setup(cwd)
  await start()
  fake.deliver(
    larkEvent({
      root_id: 'unknown',
      thread_id: 'unknown-thread',
      mentions: [],
    }),
  )
  await t.internals.gateway.stopAll()
  expect(fake.sent).toEqual([])
  expect(fake.cards).toEqual([])
  expect(fake.reactions).toEqual([])
  expect(fake.topicHistoryCalls).toEqual([])
  expect(
    await readdir(join(t.vela.dataDir, 'channels')).catch(() => []),
  ).toEqual([])
  expect(
    await readdir(join(t.vela.dataDir, 'sessions')).catch(() => []),
  ).toEqual([])
})

test('a corrupt directory stops channel startup with its path in a clear error', async () => {
  const cwd = await root()
  const { t, start } = setup(cwd)
  await mkdir(join(t.vela.dataDir, 'channels'), { recursive: true })
  await writeFile(join(t.vela.dataDir, 'channels/index.json'), '{broken')
  await expect(start()).rejects.toThrow('index.json')
})

test('recovery does not send or run work for a group removed from the enabled list', async () => {
  const cwd = await crash('saved')
  const { fake, t, start } = setup(cwd, [], [])
  await start()
  expect(fake.sent).toEqual([])
  expect(t.model.calls).toEqual([])
})

test('recovery retains saved images without downloading the original resources again', async () => {
  const cwd = await crash('image')
  const { fake, t, start } = setup(cwd, [fauxText('image recovered')])
  await start()
  await until(() => fake.sent.some((m) => m.text.includes('image recovered')))
  expect(JSON.stringify(t.model.calls[0]?.prompt)).toContain('image/jpeg')
  expect(fake.resourceCalls).toEqual([])
})

test('an unappended queued steer receives its own resend notice while the saved task recovers', async () => {
  const cwd = await crash('steer')
  const { fake, t, start } = setup(cwd, [fauxText('original recovered')])
  await start()
  await until(() =>
    fake.sent.some((m) => m.text.includes('original recovered')),
  )
  expect(fake.sent[0]?.text.includes('<at ')).toBe(false)
  expect(fake.sent[0]).toMatchObject({
    messageId: 'steer',
    text: expect.stringContaining('send it again'),
  })
  expect(t.model.calls).toHaveLength(1)
  expect(JSON.stringify(t.model.calls[0]?.prompt)).not.toContain(
    'also check blue',
  )
})

async function records(dataDir: string) {
  return JSON.parse(
    await readFile(join(dataDir, 'channels/index.json'), 'utf8'),
  ).records as {
    state: string
    pendingMessageIds: string[]
  }[]
}

test('graceful shutdown preserves the interrupted run and its unsaved steer for restart', async () => {
  const cwd = await root()
  const first = setup(cwd, [fauxHang()])
  await first.start()
  first.fake.deliver(larkEvent({ root_id: 'root', thread_id: 'thread' }))
  await until(() => first.t.model.calls.length === 1)
  const session = first.t.vela.session('lark-oc_group-root')
  first.fake.deliver(
    larkEvent(
      {
        message_id: 'pending',
        root_id: 'root',
        thread_id: 'thread',
        mentions: [],
        content: '{"text":"later input"}',
      },
      'ou_bob',
    ),
  )
  await until(() => session.queue.steering.length === 1)
  await first.t.cleanup({ keepDir: true })
  expect((await records(first.t.vela.dataDir))[0]).toMatchObject({
    state: 'running',
    pendingMessageIds: ['pending'],
  })
  const second = setup(cwd, [fauxText('continued after shutdown')])
  await second.start()
  await until(() =>
    second.fake.sent.some((m) => m.text.includes('continued after shutdown')),
  )
  expect(
    second.fake.sent.some(
      (m) => m.messageId === 'pending' && m.text.includes('send it again'),
    ),
  ).toBe(true)
  expect(second.fake.sent.some((m) => m.text.includes('interrupted'))).toBe(
    true,
  )
  expect(second.t.model.calls).toHaveLength(1)
})

test('a delivered terminal execution failure is not retried after restart', async () => {
  const cwd = await root()
  const first = setup(cwd, [fauxError('400 permanent provider failure')])
  await first.start()
  first.fake.deliver(larkEvent({ root_id: 'root', thread_id: 'thread' }))
  await until(() => first.fake.sent.some((m) => m.text.includes('Task failed')))
  await first.t.cleanup({ keepDir: true })
  expect((await records(first.t.vela.dataDir))[0]?.state).toBe('done')
  const second = setup(cwd)
  await second.start()
  await second.t.cleanup({ keepDir: true })
  expect(second.fake.sent).toEqual([])
  expect(second.t.model.calls).toEqual([])
})

test('failed final delivery stays recoverable and delivers the saved answer without a model call', async () => {
  const cwd = await root()
  const first = setup(cwd, [fauxText('answer awaiting delivery')])
  first.fake.failReply()
  await first.start()
  first.fake.deliver(larkEvent({ root_id: 'root', thread_id: 'thread' }))
  await until(() => first.t.eventsOf('channel_error').length > 0)
  await first.t.cleanup({ keepDir: true })
  expect((await records(first.t.vela.dataDir))[0]?.state).toBe('running')
  const second = setup(cwd)
  await second.start()
  await until(() =>
    second.fake.sent.some((m) => m.text.includes('answer awaiting delivery')),
  )
  expect(second.t.model.calls).toEqual([])
})

for (const active of [false, true]) {
  test(`handled preparation rejection clears only its admission (${active ? 'steer' : 'idle'})`, async () => {
    const cwd = await root()
    const first = setup(cwd, active ? [fauxHang()] : [])
    await first.start()
    if (active) {
      first.fake.deliver(larkEvent({ root_id: 'root', thread_id: 'thread' }))
      await until(() => first.t.model.calls.length === 1)
    }
    first.fake.deliver(
      larkEvent({
        message_id: 'rejected',
        root_id: 'root',
        thread_id: 'thread',
        message_type: 'audio',
        content: '{"file_key":"audio"}',
      }),
    )
    await until(() => first.fake.sent.some((m) => m.messageId === 'rejected'))
    if (active) {
      first.fake.click(0, 'stop')
      await until(() => first.fake.sent.some((m) => m.text.includes('Stopped')))
    }
    await first.t.cleanup({ keepDir: true })
    expect((await records(first.t.vela.dataDir))[0]?.pendingMessageIds).toEqual(
      [],
    )
    const second = setup(cwd)
    await second.start()
    await second.t.cleanup({ keepDir: true })
    expect(second.fake.sent).toEqual([])
    expect(second.t.model.calls).toEqual([])
  })
}

test('a recovered top-level group input retains channel tools and prompt classification', async () => {
  const cwd = await crash('group')
  const { fake, t, start } = setup(cwd, [fauxText('group recovered')])
  await start()
  await until(() => fake.sent.some((m) => m.text.includes('group recovered')))
  expect(t.model.calls[0]?.tools).toContain('lark_start_topic')
  expect(t.model.calls[0]?.system).toContain('channel session for this group')
  expect(fake.sent.at(-1)?.messageId).toBe('trigger')
})

test('a recovered group run forwards its saved input without needing a live raw event (SDK regression)', async () => {
  const cwd = await crash('forward')
  const { fake, t, start } = setup(cwd, [
    fauxToolCall('lark_forward_to_topic', { root_id: 'root' }),
    (req) =>
      fauxText(
        req.tools.includes('lark_start_topic')
          ? 'forwarded'
          : 'recovered forward answer',
      ),
    (req) =>
      fauxText(
        req.tools.includes('lark_start_topic')
          ? 'forwarded'
          : 'recovered forward answer',
      ),
  ])
  await start()
  await until(() =>
    fake.sent.some((m) => m.text.includes('recovered forward answer')),
  )
  expect(fake.forwards).toEqual([{ messageId: 'trigger', threadId: 'thread' }])
  expect(fake.topics).toEqual([])
  expect(
    t.model.calls.filter((call) => !call.tools.includes('lark_start_topic'))[0]
      ?.lastUserText,
  ).toContain('remember cobalt')
})

test('restart drops active and queued passive work with operator diagnostics and does not replay duplicate delivery', async () => {
  const cwd = await crash('passive')
  const fake = fakeLark()
  const logs: string[] = []
  const t = createTestVela({
    cwd,
    responses: [fauxText('explicit after restart')],
    logger: {
      ...silentLogger,
      info: (line) => logs.push(line),
      warn: (line) => logs.push(line),
    },
    extensions: [lark({ chats: ['oc_group'], transport: fake.transport })],
  })
  await t.vela.startChannels()
  for (const message_id of ['trigger', 'queued-passive'])
    fake.deliver(
      larkEvent({
        message_id,
        mentions: [],
        content: '{"text":"duplicate discussion"}',
      }),
    )
  fake.deliver(larkEvent({ message_id: 'explicit-after' }))
  await until(() =>
    fake.sent.some(
      (item) =>
        item.messageId === 'explicit-after' &&
        item.text === 'explicit after restart',
    ),
  )
  await t.internals.gateway.stopAll()
  expect(t.model.calls).toHaveLength(1)
  expect(fake.sent).toEqual([
    { messageId: 'explicit-after', text: 'explicit after restart' },
  ])
  expect(logs.join('\n')).toMatch(/dropped.*passive/i)
  expect(fake.cards).toEqual([])
  expect(
    fake.reactions.every((item) => item.messageId === 'explicit-after'),
  ).toBe(true)
  const index = JSON.parse(
    await readFile(join(t.vela.dataDir, 'channels/index.json'), 'utf8'),
  )
  expect(index.records[0].pendingMessageIds).toEqual([])
}, 10000)
