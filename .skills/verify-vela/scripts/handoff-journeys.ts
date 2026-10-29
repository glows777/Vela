// Offline drive of topic ↔ group hand-offs (#241), the way a group uses them: two @ requests open two
// topics, topic A hands its result straight to topic B, then a person asks the group for status.
// The extension, gateway and files are real; only the model (a router) and the Lark transport are fake.
// Run it from a verify-vela run:  $H exec $RUN handoff bun $REPO/.skills/verify-vela/scripts/handoff-journeys.ts
// It prints one line per check, marks failed checks FAIL and exits 1 if any failed.
import { createVela } from '@glows777/vela'
import {
  createFauxModel,
  type FauxRequest,
  type FauxResponse,
} from '@glows777/vela/testing'
import { lark } from '@glows777/vela-lark'
import { fakeLark, larkEvent } from '../../../test/support/lark.ts'

const failed: string[] = []
function check(label: string, value: unknown, ok = true) {
  const shown = typeof value === 'string' ? value : JSON.stringify(value)
  console.log(`${ok ? '' : 'FAIL '}${label}: ${shown}`)
  if (!ok) failed.push(label)
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
async function until(what: string, ok: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`)
    await sleep(10)
  }
}

const call = (name: string, input: unknown): FauxResponse => ({
  toolCalls: [{ name, input }],
})
// Answer by what each request is, so concurrent sessions never race a queue.
function router(req: FauxRequest): FauxResponse {
  const text = req.lastUserText
  const done = req.toolResults.length > 0
  if (req.tools.includes('lark_start_topic')) {
    if (done) return { text: '' }
    if (/release confirmation/.test(text))
      return call('lark_start_topic', {
        title: 'Release confirmation',
        brief:
          'Prepare the release confirmation; topic "Find the code" supplies the code.',
      })
    if (/verification code/.test(text))
      return call('lark_start_topic', {
        title: 'Find the code',
        brief:
          'Find the release verification code and give it to the "Release confirmation" topic (root_id group_b).',
      })
    return { text: 'Both topics are done.' }
  }
  if (text.startsWith("Message from Vela's"))
    return { text: 'Release confirmed with ORBIT-73.' }
  if (text.includes('Prepare the release confirmation'))
    return { text: 'Waiting for the code.' }
  if (done) return { text: 'Gave the code to the release topic.' }
  return call('channel_message_topic', {
    root_id: 'group_b',
    text: 'The release verification code is ORBIT-73.',
  })
}

const model = createFauxModel({
  responses: Array.from({ length: 50 }, () => router),
})
const fake = fakeLark()
const vela = createVela({
  model,
  extensions: [
    lark({
      appId: 'bot',
      owners: ['ou_alice'],
      chats: ['oc_group'],
      transport: fake.transport,
    }),
  ],
})
try {
  await vela.ready()
  await vela.startChannels()
  fake.deliver(
    larkEvent({
      message_id: 'group_b',
      content: '{"text":"@_user_1 prepare the release confirmation"}',
    }),
  )
  await until('B answers', () => fake.sent.length === 1)
  fake.deliver(
    larkEvent({
      message_id: 'group_a',
      content: '{"text":"@_user_1 find the release verification code"}',
    }),
  )
  await until('B confirms', () =>
    fake.sent.some((item) => item.text.includes('Release confirmed')),
  )
  await sleep(100)
  const calls = model.calls.length
  check(
    'topics opened',
    fake.topics.map((topic) => topic.title),
    fake.topics.length === 2,
  )
  check(
    'A first input has the original message verbatim',
    model.calls.find((req) => req.lastUserText.includes('Find the release'))
      ?.lastUserText,
    !!model.calls.some((req) =>
      req.lastUserText.includes(
        "[Alice's original message, verbatim]\nfind the release verification code",
      ),
    ),
  )
  check(
    'visible messages',
    fake.sent.map((item) => item.text),
    fake.sent.length === 3 &&
      !fake.sent.some((item) => item.text.includes('verification code is')),
  )
  check('forwards for the hop', fake.forwards, fake.forwards.length === 0)
  const note = model.calls.find((req) =>
    req.lastUserText.startsWith("Message from Vela's"),
  )
  check('B received the note', note?.lastUserText, !!note)

  fake.deliver(larkEvent({ content: '{"text":"@_user_1 status?"}' }))
  await until('status answer', () =>
    fake.sent.some((item) => item.text.includes('Both topics are done')),
  )
  check('model calls between the topics finishing and the question', calls)
  const status = JSON.stringify(model.calls.at(-1)?.prompt)
  check(
    'group request carries the status lines',
    status.match(/Status from Vela[^"]*/)?.[0],
    status.includes('finished: Release confirmed with ORBIT-73') &&
      status.includes('→ topic \\"Release confirmation\\"'),
  )
} catch (error) {
  check('journey', String(error), false)
} finally {
  await vela.dispose()
}
console.log(failed.length ? `FAILED: ${failed.join(', ')}` : 'DONE')
process.exit(failed.length ? 1 : 0)
