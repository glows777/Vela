// Public SDK acceptance: only the model and channel transport are fake.
// Run with vela-verify.sh exec <run> runtime bun <absolute path to this script>.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createVela } from '@glows777/vela'
import type {
  ChannelDefinition,
  ChannelRuntime,
  IncomingMessage,
  OutgoingMessage,
} from '@glows777/vela-channels'
import { drainChannels } from '@glows777/vela-channels/testing'
import {
  createFauxModel,
  fauxHang,
  fauxText,
} from '@glows777/vela-core/testing'

let runtime!: ChannelRuntime
let other!: ChannelRuntime
let release!: () => void
const preparation = new Promise<void>((resolve) => {
  release = resolve
})
const sent: OutgoingMessage[] = []
const channel: ChannelDefinition = {
  name: 'fixture',
  description: 'Public runtime acceptance adapter',
  start() {},
  stop() {},
  connect(value) {
    runtime = value
  },
  async prepareMessage(message) {
    if (message.text === 'held preparation') await preparation
    return message
  },
  async send(message) {
    sent.push(message)
  },
}
const model = createFauxModel({
  responses: [
    fauxHang(),
    fauxText('later message completed'),
    fauxText('topic result'),
  ],
})
const dataDir = process.env.VELA_DIR!
assert.ok(dataDir, 'Run through the isolated verify-vela helper')
const vela = createVela({
  model,
  dataDir,
  cwd: process.cwd(),
  extensions: [
    function runtimeFixture(api) {
      api.registerChannel(channel)
      api.registerChannel({
        ...channel,
        name: 'other',
        connect(value) {
          other = value
        },
      })
    },
  ],
})
const input = (
  text: string,
  rest: Partial<IncomingMessage> = {},
): IncomingMessage => ({
  channelId: 'project',
  chatKind: 'group',
  senderId: 'owner',
  senderName: 'Owner',
  text,
  ...rest,
})
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Runtime journey timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
try {
  await vela.startChannels()
  const admitted = await runtime.submit(input('held preparation'))
  assert.equal(model.calls.length, 0)
  const index = JSON.parse(
    await readFile(join(dataDir, 'channels/index.json'), 'utf8'),
  )
  assert.ok(JSON.stringify(index).includes(admitted.sessionId))
  assert.equal(runtime.scope(admitted.sessionId)?.chatKind, 'group')
  console.log(
    'submit acknowledged durable admission before preparation/model completion',
  )
  await until(() => !!runtime.sessions('project')[0]?.runId)
  const runId = runtime.sessions('project')[0]!.runId!
  assert.equal(await runtime.stop({ chatId: 'project' }, runId), true)
  release()
  await drainChannels(vela)
  assert.equal(model.calls.length, 0)
  assert.equal(await runtime.stop({ chatId: 'project' }, runId), false)
  console.log('run-scoped Stop cancels preparation; stale Stop is rejected')

  await runtime.submit(input('first model run', { replyToId: 'first' }))
  await until(() => model.calls.length === 1)
  const active = runtime.sessions('project')[0]!.runId!
  await runtime.submit(input('later queued input', { replyToId: 'later' }))
  assert.equal(await runtime.stop({ chatId: 'project' }, active), true)
  await drainChannels(vela)
  assert.ok(sent.some((message) => message.text === 'later message completed'))
  assert.equal(model.calls.length, 2)
  const snapshots = runtime.sessions('project')
  snapshots[0]!.requester.name = 'mutated copy'
  assert.notEqual(
    runtime.sessions('project')[0]!.requester.name,
    'mutated copy',
  )
  assert.equal(other.session(admitted.sessionId), undefined)
  assert.deepEqual(other.sessions('project'), [])
  console.log(
    'Stop preserves later queued input; snapshots and lookups remain isolated',
  )

  const lines: string[] = []
  const otherLines: string[] = []
  const unsubscribe = runtime.onStatus((line) => {
    lines.push(line.text)
  })
  const unsubscribeOther = other.onStatus((line) => {
    otherLines.push(line.text)
  })
  await runtime.submit(
    input('Topic task', { topic: { rootId: 'task', threadId: 'thread' } }),
  )
  await drainChannels(vela)
  assert.equal(lines.length, 1)
  assert.ok(lines[0]!.includes('finished: topic result'))
  assert.deepEqual(otherLines, [])
  assert.equal(model.calls.length, 3)
  const saved = JSON.parse(
    await readFile(join(dataDir, 'channels/index.json'), 'utf8'),
  )
  assert.deepEqual(saved.notes['fixture-project'], lines)
  unsubscribe()
  unsubscribeOther()
  assert.equal(model.pending(), 0)
  console.log(
    'status subscription observes persisted topic result without a hub model call',
  )
  console.log('DONE')
} finally {
  release()
  await vela.dispose()
}
