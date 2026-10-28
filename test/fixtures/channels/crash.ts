import { readFileSync } from 'node:fs'
import { createTestVela } from '@glows777/vela/testing'
import { fauxHang, fauxText } from '@glows777/vela-core/testing'
import { lark } from '@glows777/vela-lark'
import { fakeLark, larkEvent } from '../../support/lark.ts'

const [cwd, mode] = process.argv.slice(2)
const fake = fakeLark()
const ready = () => console.log('CRASH_READY')
if (mode === 'image')
  fake.resources.set('screenshot', [
    readFileSync(new URL('../images/wide.png', import.meta.url)),
  ])
if (mode === 'before-append')
  fake.transport.getSenderName = async () => {
    ready()
    return new Promise(() => {})
  }
if (mode === 'answer')
  fake.transport.reply = async () => {
    ready()
    return new Promise(() => {})
  }
const t = createTestVela({
  cwd,
  responses: [
    ...(mode === 'forward' ? [fauxText('topic established')] : []),
    mode === 'answer' ? fauxText('saved answer') : fauxHang(),
  ],
  extensions: [
    lark({
      owners: ['ou_alice'],
      chats: ['oc_group'],
      transport: fake.transport,
    }),
  ],
})
await t.vela.ready()
await t.vela.startChannels()
if (mode === 'forward') {
  fake.deliver(
    larkEvent({
      message_id: 'establish',
      root_id: 'root',
      thread_id: 'thread',
      content: '{"text":"cobalt task"}',
    }),
  )
  while (!fake.sent.length) await Bun.sleep(1)
}
fake.deliver(
  larkEvent({
    message_id: 'trigger',
    ...(mode === 'passive' ? { mentions: [] } : {}),
    ...(['group', 'forward', 'passive'].includes(mode!)
      ? {}
      : { root_id: 'root', thread_id: 'thread' }),
    ...(mode === 'image'
      ? { message_type: 'image', content: '{"image_key":"screenshot"}' }
      : { content: '{"text":"remember cobalt"}' }),
  }),
)
if (
  ['saved', 'image', 'group', 'steer', 'forward', 'passive'].includes(mode!)
) {
  while (t.model.calls.length < (mode === 'forward' ? 2 : 1)) await Bun.sleep(1)
  const session = t.vela.session(
    ['group', 'forward', 'passive'].includes(mode!)
      ? 'lark-oc_group'
      : 'lark-oc_group-root',
  )
  await session.save()
  if (mode === 'steer') {
    fake.deliver(
      larkEvent(
        {
          message_id: 'steer',
          root_id: 'root',
          thread_id: 'thread',
          mentions: [],
          content: '{"text":"also check blue"}',
        },
        'ou_bob',
      ),
    )
    while (!session.queue.steering.length) await Bun.sleep(1)
  }
  if (mode === 'passive') {
    fake.deliver(
      larkEvent({
        message_id: 'queued-passive',
        mentions: [],
        content: '{"text":"another discussion"}',
      }),
    )
    const index = `${t.vela.dataDir}/channels/index.json`
    while (!readFileSync(index, 'utf8').includes('queued-passive'))
      await Bun.sleep(1)
  }
  ready()
}
setInterval(() => {}, 1000)
