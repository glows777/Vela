import { afterEach, expect, mock, test } from 'bun:test'
import { mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createVela } from '@glows777/vela'
import { createLocalExecutionEnv } from '../../packages/vela/src/driver/index.ts'
import { type LarkTransport, lark } from '../../packages/vela/src/lark/index.ts'
import { local } from '../../packages/vela/src/legacy-channels/index.ts'
import { drainChannels } from '../../packages/vela/src/legacy-channels/testing.ts'
import {
  type FauxRequest,
  fauxText,
  fauxToolCall,
} from '../../packages/vela/src/testing/core/index.ts'
import { fakeLark, larkEvent } from '../support/lark.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

const send = (path: string) => fauxToolCall('channel_send_file', { path })
const reportResult = (req: FauxRequest) =>
  fauxText(req.toolResults.at(-1)?.output ?? 'No tool result')
const ask = 'Send me the report as a file.'

test('a Local host picks up the same private bytes by owning message after overwrite, removal and restart', async () => {
  const t = createTestVela({
    extensions: [local({})],
    files: { 'report.md': 'first' },
    responses: [send('report.md'), reportResult],
  })
  await t.vela.startChannels()
  const host = t.vela.channel('local')
  const project = await host.openProject({ cwd: t.cwd })
  const address = { projectId: project.id, sessionId: project.sessionId }
  await host.submit({ ...address, text: ask })
  await drainChannels(t.vela)
  const message = host.messages(address).messages.find((row) => row.file)
  expect(message?.file).toEqual({ name: 'report.md', size: 5 })
  const pickup = { ...address, messageId: message!.id }
  await writeFile(t.path('report.md'), 'second')
  expect(new TextDecoder().decode(await host.readAttachment(pickup))).toBe(
    'first',
  )
  await rm(t.path('report.md'))
  await t.vela.dispose()
  const next = createTestVela({
    cwd: t.cwd,
    extensions: [local({})],
    responses: [
      fauxToolCall('channel_start_topic', {
        title: 'A sibling task',
        brief: 'A separate task.',
      }),
      fauxText('acknowledged'),
      fauxText('acknowledged'),
    ],
  })
  await next.vela.startChannels()
  const resumed = next.vela.channel('local')
  expect(new TextDecoder().decode(await resumed.readAttachment(pickup))).toBe(
    'first',
  )
  await resumed.submit({ ...address, text: 'Start another topic.' })
  await drainChannels(next.vela)
  const sibling = resumed.sessions(project.id).find((row) => row.topic)
  expect(sibling).toBeDefined()
  await expect(
    resumed.readAttachment({ ...pickup, sessionId: sibling!.sessionId }),
  ).rejects.toThrow(/not found/i)
  await mkdir(t.path('another'))
  const other = await resumed.openProject({ cwd: t.path('another') })
  await expect(
    resumed.readAttachment({
      projectId: other.id,
      sessionId: other.sessionId,
      messageId: message!.id,
    }),
  ).rejects.toThrow(/not found/i)
  await expect(
    resumed.readAttachment({ ...pickup, sessionId: 'unrelated' }),
  ).rejects.toThrow(/not found/i)
})

test('Lark sends files to the admitted topic, and errors use one ordinary reply without failing the run', async () => {
  const fake = fakeLark()
  const post = mock<NonNullable<LarkTransport['sendFile']>>(
    async (_chat, file) => {
      if (file.name === 'uncertain.patch') throw new Error('receipt lost')
      return { messageId: 'om_file', createTime: '10' }
    },
  )
  fake.transport.sendFile = post
  const cases = [
    ['report.patch', 'file'],
    ['plot.png', 'image'],
    ['large.png', 'file'],
    ['plot.svg', 'file'],
    ['missing.md', /not found/i],
    ['huge.md', /30 MB/],
    ['empty.md', /empty/i],
    ['escape.md', /inside|outside/i],
    ['uncertain.patch', /did not confirm|uncertain/i],
  ] as const
  const t = createTestVela({
    extensions: [
      lark({ chats: ['oc_group'], owners: [], transport: fake.transport }),
    ],
    responses: cases.flatMap(([path]) => [send(path), reportResult]),
  })
  await t.vela.startChannels()
  const workspace = t.dataPath('channels/lark-oc_group/workspace')
  await mkdir(workspace, { recursive: true })
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBk0AAAAASUVORK5CYII=',
    'base64',
  )
  for (const [name, bytes] of [
    ['report.patch', 'diff'],
    ['plot.png', png],
    ['large.png', png],
    ['plot.svg', '<svg/>'],
    ['empty.md', ''],
    ['huge.md', ''],
    ['uncertain.patch', 'diff'],
  ] as const)
    await writeFile(join(workspace, name), bytes)
  await truncate(join(workspace, 'huge.md'), 30_000_001)
  await truncate(join(workspace, 'large.png'), 10_000_001)
  await writeFile(t.path('outside.md'), 'private')
  await symlink(t.path('outside.md'), join(workspace, 'escape.md'))
  const outcomes: string[] = []
  t.vela.channel('lark').onSession(({ run }) => {
    if (run?.type === 'finished') outcomes.push(run.outcome)
  })
  for (const [name, expected] of cases) {
    const count = post.mock.calls.length
    const messageId = `trigger-${name}`
    fake.deliver(
      larkEvent({
        message_id: messageId,
        root_id: 'om_root',
        thread_id: 'omt_thread',
        content: JSON.stringify({ text: ask }),
      }),
    )
    await drainChannels(t.vela)
    if (typeof expected === 'string') {
      expect(post.mock.calls.slice(count)).toMatchObject([
        [
          'oc_group',
          { name, kind: expected },
          {
            replyToId: 'om_root',
            replyInThread: true,
            uuid: expect.any(String),
          },
        ],
      ])
    } else {
      expect(post.mock.calls.length - count).toBe(
        name === 'uncertain.patch' ? 1 : 0,
      )
      const replies = fake.sent.filter(
        (message) => message.messageId === messageId,
      )
      expect(replies).toHaveLength(1)
      expect(replies[0]!.text).toMatch(expected)
      expect(replies[0]!.text).not.toContain('\n')
    }
    expect(outcomes.at(-1)).toBe('done')
  }
}, 20_000)

test('unsupported transports and explicit chat tool selections omit channel_send_file', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    extensions: [
      lark({ owners: [], chats: ['oc_group'], transport: fake.transport }),
    ],
    responses: [fauxText('ok')],
  })
  await t.vela.startChannels()
  fake.deliver(larkEvent())
  await drainChannels(t.vela)
  expect(t.model.calls[0]!.tools).not.toContain('channel_send_file')
  const narrowed = fakeLark()
  narrowed.transport.sendFile = async () => ({
    messageId: 'unused',
    createTime: '10',
  })
  const second = createTestVela({
    extensions: [
      lark({
        owners: [],
        chats: [{ id: 'oc_group', tools: ['read'] }],
        transport: narrowed.transport,
      }),
    ],
    responses: [fauxText('ok')],
  })
  await second.vela.startChannels()
  narrowed.deliver(larkEvent())
  await drainChannels(second.vela)
  expect(second.model.calls[0]!.tools).not.toContain('channel_send_file')
})

test('the active environment can reject an oversized file before the first byte read', async () => {
  let reads = 0,
    closed = 0
  const t = createTestVela(
    {
      files: { 'virtual.txt': 'host file' },
      responses: [send('virtual.txt'), reportResult],
    },
    (options) =>
      createVela({
        ...options,
        extensions: [local({})],
        env: ({ location }) => {
          const env = createLocalExecutionEnv({ cwd: location.cwd })
          const open = env.openBinaryReader.bind(env)
          env.openBinaryReader = async (path, flags, signal) => {
            const result = await open(path, flags, signal)
            if (result.ok && path.endsWith('virtual.txt')) {
              const reader = result.value,
                info = reader.info.bind(reader),
                close = reader.close.bind(reader)
              reader.info = async (signal) => {
                const stat = await info(signal)
                return stat.ok
                  ? { ok: true, value: { ...stat.value, size: 30_000_001 } }
                  : stat
              }
              reader.read = async () => {
                reads++
                throw new Error('Should not read oversized bytes')
              }
              reader.close = async () => {
                closed++
                await close()
              }
            }
            return result
          }
          return env
        },
      }),
  )
  await t.vela.startChannels()
  const host = t.vela.channel('local')
  const project = await host.openProject({ cwd: t.cwd })
  const address = { projectId: project.id, sessionId: project.sessionId }
  await host.submit({ ...address, text: 'Send virtual.txt' })
  await drainChannels(t.vela)
  expect(host.messages(address).messages.at(-1)?.text).toContain('30 MB')
  expect(reads).toBe(0)
  expect(closed).toBe(1)
})

test('only the admitted owner DM can deliver to its current chat without a group reply anchor', async () => {
  const fake = fakeLark()
  const post = mock<NonNullable<LarkTransport['sendFile']>>(async () => ({
    messageId: 'dm-receipt',
    createTime: '1',
  }))
  fake.transport.sendFile = post
  const t = createTestVela({
    files: { 'answer.txt': 'answer' },
    responses: [send('answer.txt'), reportResult],
    extensions: [
      lark({
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.startChannels()
  fake.deliver(
    larkEvent({ chat_id: 'disabled', root_id: 'root', thread_id: 'thread' }),
  )
  fake.deliver(
    larkEvent({ root_id: 'unowned', thread_id: 'unknown', mentions: [] }),
  )
  const dm = { chat_id: 'oc_direct', chat_type: 'p2p', mentions: [] }
  fake.deliver(larkEvent(dm, 'ou_stranger'))
  await drainChannels(t.vela)
  expect(post).not.toHaveBeenCalled()
  expect(t.model.calls).toHaveLength(0)
  fake.deliver(larkEvent(dm))
  await drainChannels(t.vela)
  expect(post.mock.calls).toMatchObject([
    [
      'oc_direct',
      { name: 'answer.txt', kind: 'file' },
      { replyToId: undefined, replyInThread: undefined },
    ],
  ])
})
