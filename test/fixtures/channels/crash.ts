import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestVela } from '@glows777/vela/testing'
import {
  type FauxRequest,
  fauxHang,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'
import { lark } from '@glows777/vela-lark'
import { fakeLark, larkEvent } from '../../support/lark.ts'

const [cwd, mode] = process.argv.slice(2)
const fake = fakeLark()
const ready = () => console.log('CRASH_READY')
let held = false
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
// 'note': topic root answers, topic other hands it a note, and the process dies during the note run.
const note = (req: FauxRequest) => {
  if (req.lastUserText.startsWith("Message from Vela's")) return fauxHang()
  if (req.lastUserText.includes('remember cobalt'))
    return fauxText('first answer')
  return req.toolResults.length
    ? fauxText('handed')
    : fauxToolCall('channel_message_topic', {
        root_id: 'root',
        text: 'cobalt is ready',
      })
}
const t = createTestVela({
  cwd,
  responses: mode?.startsWith('note')
    ? Array(5).fill(note)
    : [
        ...(mode === 'forward' ? [fauxText('topic established')] : []),
        mode === 'answer' ? fauxText('saved answer') : fauxHang(),
      ],
  extensions: [
    lark({
      owners: ['ou_alice'],
      chats: ['oc_group'],
      transport: fake.transport,
    }),
    // 'note-early': the process dies after the note run began but before the note is appended.
    (api) => {
      api.on('before_agent_start', (_event, { session }) => {
        if (
          mode !== 'note-early' ||
          session.id !== 'lark-oc_group-root' ||
          !session.messages.some((message) => message.role === 'assistant')
        )
          return
        held = true
        return new Promise(() => {})
      })
    },
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
if (mode?.startsWith('note')) {
  while (fake.sent.length < 1) await Bun.sleep(1)
  fake.deliver(
    larkEvent({
      message_id: 'other',
      root_id: 'other',
      thread_id: 'thread_other',
      content: '{"text":"hand cobalt to root"}',
    }),
  )
  // Topic other has finished; root's note run is in progress (or held before its note is appended).
  const index = `${t.vela.dataDir}/channels/index.json`
  const otherDone = () =>
    JSON.parse(readFileSync(index, 'utf8')).records.some(
      (record: { rootId?: string; state: string }) =>
        record.rootId === 'other' && record.state === 'done',
    )
  while (
    !(
      held ||
      t.model.calls.some((call) =>
        call.lastUserText.includes('cobalt is ready'),
      )
    ) ||
    !otherDone()
  )
    await Bun.sleep(1)
  // Session entries are written as they are appended; wait for the note to reach the file.
  const saved = () =>
    readdirSync(t.vela.dataDir, { recursive: true, encoding: 'utf8' }).some(
      (name) =>
        name.endsWith('lark-oc_group-root.jsonl') &&
        readFileSync(join(t.vela.dataDir, name), 'utf8').includes(
          'cobalt is ready',
        ),
    )
  if (mode === 'note') while (!saved()) await Bun.sleep(5)
  ready()
}
setInterval(() => {}, 1000)
