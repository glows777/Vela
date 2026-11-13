// Run with vela-verify.sh exec in its isolated fixture. Only the model and Lark network are fake.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createChannelVela, local } from '@glows777/vela-channels'
import { drainChannels } from '@glows777/vela-channels/testing'
import {
  createFauxModel,
  fauxHang,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'
import { lark } from '@glows777/vela-lark'
import { fakeLark, larkEvent } from '../../../test/support/lark.ts'

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    assert(Date.now() < deadline, 'SDK condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
const network = fakeLark()
const logs: string[] = []
const model = createFauxModel({
  responses: [
    fauxText('Existing topic ready'),
    fauxToolCall('channel_wait_for_input', { reason: 'Choose a color' }),
    fauxText('Which color?'),
    fauxText('Local reply'),
    fauxHang(),
    fauxText('Queued work completed'),
  ],
})
const vela = createChannelVela({
  cwd: process.cwd(),
  dataDir: resolve('host-data'),
  contextFiles: false,
  model,
  extensions: [
    lark({
      owners: ['ou_alice'],
      chats: ['oc_group'],
      transport: network.transport,
    }),
    local({ token: 'offline-host-fixture', port: 0 }),
  ],
  logger: {
    debug() {},
    info(line) {
      logs.push(line)
    },
    warn(line) {
      logs.push(line)
    },
    error(line) {
      logs.push(line)
    },
  },
})
await vela.ready()
const host = vela.channel('lark')
const localHost = vela.channel('local')
const connections: boolean[] = []
const transitions: string[] = []
const statuses: string[] = []
host.onConnection((value) => connections.push(value.connected))
host.onSession((update) => {
  if (update.run) transitions.push(update.run.type)
})
host.onStatus((line) => statuses.push(line.text))
assert.deepEqual(host.connection(), { connected: false })
try {
  await vela.startChannels()
  assert(host.connection().connected && localHost.connection().connected)
  network.deliver(
    larkEvent({
      message_id: 'owned-root',
      root_id: 'owned-root',
      thread_id: 'owned-thread',
    }),
  )
  await drainChannels(vela)
  const topic = host.sessions()[0]!
  const receipt = await host.submit({
    channelId: topic.chatId,
    topic: topic.topic,
    replyToId: 'host-service-anchor',
    senderId: 'ou_alice',
    senderName: 'Alice',
    text: 'Continue the topic',
  })
  assert.equal(receipt.sessionId, topic.sessionId)
  await drainChannels(vela)
  assert.equal(host.sessions()[0]!.waitingReason, 'Choose a color')
  assert(
    statuses.length &&
      transitions.includes('started') &&
      transitions.includes('finished'),
  )
  assert.equal(network.sent.at(-1)!.messageId, 'host-service-anchor')
  console.log(
    'Lark host: owned topic replied at the fixture anchor; waiting reason and status observed',
  )
  const localURL = logs.join(' ').match(/http:\/\/127\.0\.0\.1:\d+/)![0]
  const request = async (path: string, body: unknown) => {
    const response = await fetch(localURL + path, {
      method: 'POST',
      headers: {
        authorization: 'Bearer offline-host-fixture',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    assert(response.ok, await response.clone().text())
    return response.json()
  }
  const project = (await request('/v1/projects', { cwd: process.cwd() })) as {
    id: string
    sessionId: string
  }
  await request(
    `/v1/projects/${project.id}/sessions/${project.sessionId}/messages`,
    { text: 'Local hello' },
  )
  await drainChannels(vela)
  assert.equal(localHost.sessions()[0]!.chatId, project.id)
  assert.equal(host.sessions().length, 1)
  console.log(
    'Host lists Lark and Local independently; existing Local HTTP composer remains usable',
  )
  const target = { chatId: topic.chatId, rootId: topic.topic!.rootId }
  const reminder = await host.routines.create(target, {
    message: 'Review report',
    schedule: { time: '09:00' },
    creator: { id: 'ou_alice', name: 'Alice' },
  })
  assert.equal(
    host.routines.list({ chatId: target.chatId }).routines[0]!.id,
    reminder.id,
  )
  assert(await host.routines.cancel({ chatId: target.chatId }, reminder.id))
  console.log(
    'Idle host routine created, listed and cancelled using the shared scheduler',
  )
  const groupInput = {
    channelId: 'oc_group',
    replyToId: 'busy-anchor',
    senderId: 'ou_alice',
    senderName: 'Alice',
    text: 'Hold this run',
  }
  await host.submit(groupInput)
  await until(() => model.calls.length === 5)
  const active = host.sessions('oc_group').find((session) => !session.topic)!
  await host.submit({
    ...groupInput,
    replyToId: 'queued-anchor',
    text: 'Queued request',
  })
  assert.equal(await host.stop({ chatId: 'oc_group' }, 'expired'), false)
  assert(await host.stop({ chatId: 'oc_group' }, active.runId!))
  await drainChannels(vela)
  assert(
    network.sent.some((message) => message.text === 'Queued work completed'),
  )
  assert.equal(await host.stop({ chatId: 'oc_group' }, active.runId!), false)
  console.log(
    'Exact Stop ended the held run, rejected stale Stop and preserved later queued input',
  )
  const directory = JSON.parse(
    await readFile(resolve('host-data/channels/index.json'), 'utf8'),
  )
  assert(
    directory.records.some(
      (record: { channel: string }) => record.channel === 'local',
    ),
  )
  assert(
    directory.records.some(
      (record: { waitingReason?: string }) =>
        record.waitingReason === 'Choose a color',
    ),
  )
  assert.equal(model.pending(), 0)
} finally {
  await vela.dispose()
}
assert.deepEqual(connections, [true, false])
assert.deepEqual(host.connection(), { connected: false })
console.log('Disposed: host reports disconnected')
