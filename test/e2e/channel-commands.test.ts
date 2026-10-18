import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChannelDirectory } from '../../src/channels/directory.ts'
import { feishu } from '../../src/extensions/feishu/index.ts'
import { fauxHang, fauxText } from '../../src/testing/faux.ts'
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
  const deadline = Date.now() + 1500
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Topic command did not finish')
    await Bun.sleep(1)
  }
}

function message(text: string, mentioned = true) {
  return feishuEvent({
    root_id: 'root',
    thread_id: 'thread',
    content: JSON.stringify({ text: mentioned ? `@_user_1 ${text}` : text }),
    mentions: mentioned ? [{ key: '@_user_1', id: { open_id: 'ou_bot' } }] : [],
  })
}

test.each([
  [false, true],
  [true, true],
  [false, false],
  [true, false],
])(
  'restart persistence stays consistent with a later admission (other topic=%s, failed write=%s)',
  async (otherTopic, failWrite) => {
    const { fake, t } = await setup()
    fake.deliver(message('original task'))
    await until(() => fake.sent.length === 1)
    const oldId = 'feishu-oc_group-root'
    const path = t.dataPath('channels/index.json')
    let releaseWrite!: () => void
    const heldWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    let releasePreparation!: () => void
    const heldPreparation = new Promise<void>((resolve) => {
      releasePreparation = resolve
    })
    let restartWriteStarted = false
    let preparationStarted = false
    let admitted!: Promise<void>
    let admissionStarted = false
    const rename = fs.rename
    const admit = ChannelDirectory.prototype.admit
    const renameSpy = spyOn(fs, 'rename').mockImplementation(
      async (from, to) => {
        if (to === path && !restartWriteStarted) {
          const snapshot = JSON.parse(await fs.readFile(from, 'utf8'))
          if (
            snapshot.records.find((r: { key: string }) => r.key === oldId)
              ?.activeSessionId !== oldId
          ) {
            restartWriteStarted = true
            await heldWrite
            if (failWrite) throw new Error('simulated index rename failure')
          }
        }
        await rename(from, to)
      },
    )
    const admitSpy = spyOn(
      ChannelDirectory.prototype,
      'admit',
    ).mockImplementation(function (key, channel, msg) {
      const result = admit.call(this, key, channel, msg)
      if (msg.replyToId === 'later-input') {
        admitted = result
        admissionStarted = true
      }
      return result
    })
    fake.transport.getSenderName = async () => {
      preparationStarted = true
      await heldPreparation
      return 'Bob'
    }
    try {
      fake.deliver(message('!restart'))
      await until(() => restartWriteStarted)
      const later = message('later input')
      later.sender.sender_id = { open_id: 'ou_bob' }
      later.message.message_id = 'later-input'
      if (otherTopic)
        Object.assign(later.message, {
          root_id: 'other',
          thread_id: 'other-thread',
        })
      fake.deliver(later)
      await until(() => admissionStarted)
      releaseWrite()
      await admitted
      await until(
        () =>
          preparationStarted &&
          fake.sent.some((m) =>
            m.text.includes(
              failWrite
                ? 'simulated index rename failure'
                : 'Restarted with a fresh session',
            ),
          ),
      )
      const records = JSON.parse(
        await t.readData('channels/index.json'),
      ).records
      expect(
        records.find((r: { key: string }) => r.key === oldId),
      ).toMatchObject({
        activeSessionId: failWrite
          ? oldId
          : expect.not.stringMatching(/^feishu-/),
        previousSessionIds: failWrite ? [] : [oldId],
      })
      expect(
        records.find(
          (r: { key: string }) =>
            r.key === (otherTopic ? 'feishu-oc_group-other' : oldId),
        ).pendingMessageIds,
      ).toContain('later-input')
      expect(t.model.calls).toHaveLength(1)
      expect(
        fake.sent.some((m) =>
          m.text.includes('Restarted with a fresh session'),
        ),
      ).toBe(!failWrite)
    } finally {
      releaseWrite()
      const stopping = t.internals.gateway.stopAll()
      releasePreparation()
      await stopping
      renameSpy.mockRestore()
      admitSpy.mockRestore()
    }
  },
)

test.each([false, true])(
  'active !restart drains the old run and stale Stop cannot cancel its successor (mentioned=%s)',
  async (mentioned) => {
    const { fake, t } = await setup(fauxHang('old work'))
    fake.deliver(message('old task'))
    await until(() => t.model.calls.length === 1)
    fake.deliver(message('!restart', mentioned))
    // An immediately following event must wait for the generation switch, not steer old work.
    t.model.push(fauxHang('new work'))
    fake.deliver(message('new task', false))
    await until(() => t.model.calls.length === 2)
    const index = JSON.parse(await t.readData('channels/index.json'))
    const fresh = t.vela.session(index.records[0].activeSessionId)
    expect(fresh.id).not.toBe('feishu-oc_group-root')
    expect(fake.sent.map((m) => m.text)).toEqual([
      expect.stringContaining('Stopped the current run'),
      expect.stringContaining('Restarted with a fresh session'),
    ])
    expect(fake.click(0, 'stop')).toMatchObject({ toast: { type: 'info' } })
    expect(fresh.isRunning).toBe(true)
    expect(fake.click(1, 'stop')).toMatchObject({ toast: { type: 'success' } })
    await until(
      () => fake.sent.filter((m) => m.text.includes('Stopped')).length === 2,
    )
    expect(t.model.calls[1]?.lastUserText).toContain('new task')
    expect(JSON.stringify(t.model.calls[1]?.prompt)).not.toContain('!restart')
  },
)

test.each(['!stop', '!restart'])(
  'an unmentioned %s in an unowned topic has no writes or feedback',
  async (command) => {
    const fake = fakeFeishu()
    let loads = 0
    let writes = 0
    const t = createTestVela({
      responses: [],
      sessionStorage: {
        load: async () => {
          loads++
          return undefined
        },
        append: async () => {
          writes++
        },
      },
      extensions: [
        feishu({
          owners: ['ou_alice'],
          chats: ['oc_group'],
          transport: fake.transport,
        }),
      ],
    })
    await t.vela.ready()
    await t.vela.startChannels()
    fake.deliver(message(command, false))
    await until(() => loads === 1)
    await t.internals.gateway.stopAll()
    expect(fake.sent).toEqual([])
    expect(fake.reactions).toEqual([])
    expect(t.model.calls).toEqual([])
    expect(t.exists('channels/index.json')).toBe(false)
    expect(writes).toBe(0)
    expect(await readdir(t.dataPath('sessions')).catch(() => [])).toEqual([])
  },
)

test('an interrupted successor recovers under the same logical topic after process reconstruction', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'vela-generations-'))
  roots.push(cwd)
  const first = await setup(fauxText('old answer'), cwd)
  first.fake.deliver(message('old task'))
  await until(() => first.fake.sent.length === 1)
  first.fake.deliver(message('!restart'))
  await until(() => first.fake.sent.length === 2)
  const index = JSON.parse(await first.t.readData('channels/index.json'))
  const freshId = index.records[0].activeSessionId
  first.t.model.push(fauxHang('new work'))
  first.fake.deliver(message('new cobalt task', false))
  await until(() => first.t.model.calls.length === 2)
  await first.t.cleanup({ keepDir: true })
  const second = await setup(fauxText('recovered successor'), cwd)
  await until(() =>
    second.fake.sent.some((m) => m.text.includes('recovered successor')),
  )
  expect(second.fake.sent[0]?.text).toContain('interrupted')
  expect(second.t.model.calls).toHaveLength(1)
  expect(second.t.model.calls[0]?.lastUserText).toContain('new cobalt task')
  expect(second.t.eventsIn(freshId).some((e) => e.type === 'agent_start')).toBe(
    true,
  )
  await second.t.internals.gateway.stopAll()
  const recovered = JSON.parse(await second.t.readData('channels/index.json'))
    .records[0]
  expect(recovered).toMatchObject({
    activeSessionId: freshId,
    state: 'done',
    pendingMessageIds: [],
    previousSessionIds: ['feishu-oc_group-root'],
  })
})

test.each(['history', 'controls'])(
  '!restart received during %s preparation prevents the old input from starting',
  async (phase) => {
    const fake = fakeFeishu()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let loading = false
    if (phase === 'history')
      fake.transport.listTopicMessages = async () => {
        loading = true
        await held
        return { items: [] }
      }
    else {
      const sendCard = fake.transport.sendCard!
      fake.transport.sendCard = async (...args) => {
        loading = true
        await held
        return sendCard(...args)
      }
    }
    const t = createTestVela({
      responses: [],
      extensions: [
        feishu({
          owners: ['ou_alice'],
          chats: ['oc_group'],
          transport: fake.transport,
        }),
      ],
    })
    await t.vela.ready()
    await t.vela.startChannels()
    fake.deliver(message('old task'))
    await until(() => loading)
    fake.deliver(message('!restart', false))
    release()
    await until(() =>
      fake.sent.some((m) => m.text.includes('Restarted with a fresh session')),
    )
    expect(t.model.calls).toHaveLength(0)
  },
)

async function setup(response = fauxText('original answer'), cwd?: string) {
  const fake = fakeFeishu()
  const t = createTestVela({
    cwd,
    responses: [response],
    extensions: [
      feishu({
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  return { fake, t }
}

test('an admitted Stop command stays durable until the old run finishes', async () => {
  const { fake, t } = await setup(fauxHang())
  fake.deliver(message('old task'))
  await until(() => t.model.calls.length === 1)
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let delivering = false
  const reply = fake.transport.reply
  fake.transport.reply = async (...args) => {
    delivering = true
    await held
    return reply(...args)
  }
  const command = message('!stop')
  command.message.message_id = 'pending-stop'
  try {
    fake.deliver(command)
    await until(() => delivering)
    // The old run is still draining; a crash now must retain an ID for a resend notice.
    const record = JSON.parse(await t.readData('channels/index.json'))
      .records[0]
    expect(record.pendingMessageIds).toContain('pending-stop')
  } finally {
    release()
    await t.internals.gateway.stopAll()
  }
})

test.each([false, true])(
  '!stop retains the topic and continues its history (mentioned=%s)',
  async (mentioned) => {
    const { fake, t } = await setup(fauxHang('working'))
    fake.deliver(message('remember cobalt'))
    await until(() => t.model.calls.length === 1)
    fake.deliver(message('!stop', mentioned))
    await until(() =>
      fake.sent.some((m) => m.text.includes('Stopped the current run')),
    )
    const session = t.vela.session('feishu-oc_group-root')
    expect(session.isRunning).toBe(false)
    expect(t.model.calls).toHaveLength(1)
    t.model.push(fauxText('continued cobalt'))
    fake.deliver(message('continue', false))
    await until(() =>
      fake.sent.some((m) => m.text.includes('continued cobalt')),
    )
    expect(
      t.model.calls[1]?.prompt.some((m) =>
        JSON.stringify(m).includes('remember cobalt'),
      ),
    ).toBe(true)
    expect(JSON.stringify(t.model.calls[1]?.prompt)).not.toContain('!stop')
    const index = JSON.parse(await t.readData('channels/index.json'))
    expect(index.records[0].activeSessionId).toBe(session.id)
    expect(index.records[0].previousSessionIds).toEqual([])
  },
)

test.each([false, true])(
  '!restart archives idle history and the next unmentioned message loads the topic (mentioned=%s)',
  async (mentioned) => {
    const { fake, t } = await setup()
    fake.deliver(message('original task'))
    await until(() => fake.sent.length === 1)
    const oldId = 'feishu-oc_group-root'
    fake.deliver(message('!restart', mentioned))
    await until(() =>
      fake.sent.some((m) => m.text.includes('Restarted with a fresh session')),
    )
    expect(t.model.calls).toHaveLength(1)
    const index = JSON.parse(await t.readData('channels/index.json'))
    const freshId = index.records[0].activeSessionId
    expect(freshId).not.toBe(oldId)
    expect(index.records[0].previousSessionIds).toEqual([oldId])
    expect(await t.readData(`sessions/${oldId}.jsonl`)).toContain(
      'original task',
    )
    fake.topicHistory.push([
      historyMessage('prior', 'ou_bob', 'historical cobalt fact'),
    ])
    fake.topicHistoryCalls.length = 0
    t.model.push(fauxText('fresh answer'))
    fake.deliver(message('next question', false))
    await until(() => fake.sent.some((m) => m.text.includes('fresh answer')))
    expect(fake.topicHistoryCalls).toHaveLength(1)
    expect(t.model.calls[1]?.lastUserText).toContain('historical cobalt fact')
    expect(t.eventsIn(freshId).some((e) => e.type === 'agent_start')).toBe(true)
    expect(
      t.eventsIn(oldId).filter((e) => e.type === 'agent_start'),
    ).toHaveLength(1)
  },
)
