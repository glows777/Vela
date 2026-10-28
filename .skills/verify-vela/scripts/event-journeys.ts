// Run through vela-verify.sh exec: only the model and Lark transport are fake.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type ChannelEvent, createVela, loadConfig } from '@glows777/vela'
import { createFauxModel, fauxText, fauxToolCall } from '@glows777/vela/testing'
import { drainChannels } from '@glows777/vela-channels/testing'
import { lark } from '@glows777/vela-lark'
import { fakeLark, larkEvent } from '../../../test/support/lark.ts'

const fake = fakeLark()
const warnings: string[] = []
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
  logger: {
    debug() {},
    info() {},
    error() {},
    warn: (text) => warnings.push(text),
  },
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
  const failedSent = fake.sent.length
  const failedCalls = model.calls.length
  const send = fake.transport.send
  fake.transport.send = async () => {
    throw new Error('fixture announcement denied')
  }
  await vela.publishEvent({
    ...event,
    deliveryId: 'failed-announcement',
    final: false,
  })
  await drainChannels(vela)
  assert.equal(fake.sent.length, failedSent)
  assert.equal(model.calls.length, failedCalls)
  assert(warnings.some((text) => text.includes('fixture announcement denied')))
  assert.equal(JSON.parse(await readFile(path, 'utf8')).subscriptions.length, 1)
  fake.transport.send = send
  console.log(
    'PASS rejected announcement: diagnostic only, no old-human reply/model call; subscription retained',
  )
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
  const configDir = join(process.cwd(), 'fixture-config')
  await mkdir(configDir)
  await writeFile(
    join(configDir, 'settings.json'),
    JSON.stringify({
      eventDefaultTarget: { channel: ' lark ', chatId: ' oc_group ' },
    }),
  )
  assert.deepEqual(
    loadConfig({ cwd: process.cwd(), agentDir: configDir, env: {} }).settings
      .eventDefaultTarget,
    { channel: 'lark', chatId: 'oc_group' },
  )
  console.log('PASS fixture settings normalize event default target whitespace')
} finally {
  await vela.dispose()
}
assert.equal(stops, 1)
await assert.rejects(vela.publishEvent(event), /stopping|not running/)
console.log(
  'PASS lifecycle rejects publication before startup/after stop; transport stopped once',
)
