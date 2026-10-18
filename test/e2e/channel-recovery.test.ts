import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { feishu } from '../../src/extensions/feishu/index.ts'
import { fauxHang, fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { fakeFeishu, feishuEvent } from '../support/feishu.ts'
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
  const fake = fakeFeishu()
  const t = createTestVela({
    cwd,
    responses,
    extensions: [
      feishu({ owners: ['ou_alice'], chats, transport: fake.transport }),
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
    .session('feishu-oc_group-root')
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

test('completed topics survive restart and a top-level follow-up forwards to the existing thread', async () => {
  const cwd = await root()
  const first = setup(cwd, [fauxText('cobalt done')])
  await first.start()
  first.fake.deliver(feishuEvent({ root_id: 'root', thread_id: 'thread' }))
  await until(() => first.fake.sent.length > 0)
  await first.t.cleanup({ keepDir: true })
  const second = setup(cwd, [
    fauxToolCall('feishu_list_topics', {}),
    (req) => {
      expect(JSON.stringify(req.toolResults)).toContain('thread')
      return fauxToolCall('feishu_forward_to_topic', { root_id: 'root' })
    },
    (req) =>
      fauxText(
        req.tools.includes('feishu_start_topic')
          ? 'forwarded'
          : 'follow-up answer',
      ),
    (req) =>
      fauxText(
        req.tools.includes('feishu_start_topic')
          ? 'forwarded'
          : 'follow-up answer',
      ),
  ])
  await second.start()
  expect(second.fake.sent).toEqual([])
  expect(second.t.model.calls).toEqual([])
  second.fake.deliver(
    feishuEvent({
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
  first.fake.deliver(feishuEvent({ root_id: 'root', thread_id: 'thread' }))
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
    feishuEvent({
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
