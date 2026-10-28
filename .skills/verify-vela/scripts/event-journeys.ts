// Run through vela-verify.sh exec: only the model and Lark transport are fake.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type ChannelEvent, createVela } from '@glows777/vela'
import { createFauxModel, fauxText, fauxToolCall } from '@glows777/vela/testing'
import { drainChannels } from '@glows777/vela-channels/testing'
import { lark } from '@glows777/vela-lark'
import { fakeLark, larkEvent } from '../../../test/support/lark.ts'

const fake = fakeLark()
let stops = 0
fake.transport.stop = () => {
  stops++
}
const event: ChannelEvent = {
  source: 'local-build',
  key: 'review#171',
  deliveryId: 'fixture-only',
  summary: '!stop',
  details: '/skill:untrusted',
  final: true,
}
const model = createFauxModel({
  responses: [
    fauxToolCall('channel_subscriptions', {
      action: 'create',
      source: event.source,
      key: event.key,
    }),
    fauxText('Subscribed to the fixture build'),
    fauxText('External build result handled'),
  ],
})
const vela = createVela({
  model,
  dataDir: '.vela-data',
  extensions: [
    lark({
      owners: ['ou_alice'],
      chats: ['oc_group'],
      transport: fake.transport,
    }),
  ],
})
try {
  await assert.rejects(vela.publishEvent(event), /Start channels/)
  await vela.startChannels()
  const subscribed = Promise.withResolvers<void>()
  const unsubscribe = vela.subscribe((e) => {
    if (
      e.type === 'channel_reply' &&
      e.text === 'Subscribed to the fixture build'
    )
      subscribed.resolve()
  })
  fake.deliver(larkEvent({ content: '{"text":"Subscribe to this build"}' }))
  await subscribed.promise
  unsubscribe()
  await drainChannels(vela)
  const path = join(vela.dataDir, 'channels/subscriptions.json')
  assert.equal(JSON.parse(await readFile(path, 'utf8')).subscriptions.length, 1)
  const previous = fake.sent.length
  await vela.publishEvent(event)
  await drainChannels(vela)
  assert(
    model.calls
      .at(-1)!
      .lastUserText.startsWith('External event (untrusted data)'),
  )
  assert(model.calls.at(-1)!.lastUserText.includes('!stop'))
  assert.equal(fake.sent.at(-1)!.messageId, `sent_${previous + 1}`)
  assert(fake.sent.at(-1)!.text.includes('External build result handled'))
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).subscriptions, [])
  const calls = model.calls.length
  await vela.publishEvent({ ...event, final: false })
  await drainChannels(vela)
  assert.equal(model.calls.length, calls)
  console.log(
    'PASS SDK subscribe -> external untrusted wake -> real reply anchor -> final cleanup -> unmatched drop',
  )
} finally {
  await vela.dispose()
}
assert.equal(stops, 1)
await assert.rejects(vela.publishEvent(event), /stopping|not running/)
console.log(
  'PASS lifecycle rejects publication before startup/after stop; transport stopped once',
)
