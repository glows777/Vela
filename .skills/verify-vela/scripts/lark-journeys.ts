// Offline drive of the Lark channel journeys: topic handoff, untagged topic replies, the group
// workspace, passive top-level chatter (skip and a text answer), the topic overview and routines
// across a restart.
// The extension, gateway, files and timers are real; only the model (a router) and the Lark
// transport are fake. Run it from a verify-vela run (up to about 2 minutes: the last step waits
// past a real due time):  $H exec $RUN lark bun $REPO/.skills/verify-vela/scripts/lark-journeys.ts
// It prints one line per check, marks failed checks FAIL and exits 1 if any failed; adapt the
// router and steps to the change being verified.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createVela } from '@glows777/vela'
import {
  createFauxModel,
  type FauxRequest,
  type FauxResponse,
} from '@glows777/vela/testing'
import { lark } from '@glows777/vela-lark'
import { fakeLark, larkEvent } from '../../../test/support/lark.ts'
import { prepareWorkspace } from './workspace.ts'

prepareWorkspace()

type Fake = ReturnType<typeof fakeLark>
const zone = 'Asia/Shanghai'
const failed: string[] = []
/** Print one check; a false `ok` marks it FAIL and makes the script exit 1. */
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
/** Deployment-local YYYY-MM-DDTHH:mm, the format channel_routines expects for a one-off. */
function local(ms: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(ms)
      .map((part) => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

// The one-off routine's due time, set before step 5 on a minute boundary at least 30 s ahead,
// so it is still in the future when created and Vela is stopped before it fires.
let dueMs = 0

// Answer by what each request is, so concurrent channel and topic sessions never race a queue.
function router(req: FauxRequest): FauxResponse {
  const last = req.toolResults.at(-1)
  if (last)
    return { text: `after ${last.toolName}: ${last.output.slice(0, 80)}` }
  const text = req.lastUserText
  const call = (name: string, input: unknown): FauxResponse => ({
    toolCalls: [{ name, input }],
  })
  if (/investigate/i.test(text) && req.tools.includes('channel_start_topic'))
    return call('channel_start_topic', {
      title: 'Investigate the flaky test',
      brief: 'Investigate the flaky test and write down the likely cause.',
    })
  if (text.includes('Investigate the flaky test'))
    return call('write_file', { path: 'notes.md', content: 'cause: timing' })
  if (/remind/i.test(text))
    return call('channel_routines', {
      action: 'create',
      message: 'Check the PR',
      schedule: { at: local(dueMs) },
    })
  if (text.includes('Scheduled wake-up'))
    return { text: 'Reminder: check the PR' }
  if (/list topics/i.test(text)) return call('channel_list_topics', {})
  if (/lunch/i.test(text) && req.tools.includes('channel_skip_reply'))
    return call('channel_skip_reply', {})
  return { text: `ok: ${text.slice(-40)}` }
}

const model = createFauxModel({
  responses: Array.from({ length: 200 }, () => router),
})
const start = async (fake: Fake) => {
  const vela = createVela({
    dataDir: '.vela-data',
    model,
    extensionConfig: { lark: { timezone: zone } },
    extensions: [
      lark({
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await vela.startChannels()
  return vela
}
const sent = (fake: Fake, part: string) =>
  fake.sent.find((message) => message.text.includes(part))?.text
/** The `<emoji>` / `<emoji>(removed)` marks of one message's reactions so far. */
const marks = (messageId: string) =>
  fake.reactions
    .filter((reaction) => reaction.messageId === messageId)
    .map(
      (reaction) => `${reaction.emoji}${reaction.removed ? '(removed)' : ''}`,
    )
/**
 * Wait for the outcome mark, which a run adds after the answer it marks is sent: the send alone is
 * not the finish, so reading reactions right after it races the transport on a slow machine.
 */
const untilDone = (what: string, messageId: string) =>
  until(what, () => marks(messageId).includes('DONE'))

let fake = fakeLark()
let vela = await start(fake)

// 1. Top-level @ hands the task to a topic
const root = larkEvent({
  content: JSON.stringify({ text: '@_user_1 investigate the flaky test' }),
})
const rootId = root.message.message_id
const topic = { root_id: rootId, thread_id: `thread_${rootId}` }
fake.deliver(root)
await until('topic result', () => !!sent(fake, 'after write_file'))
await untilDone('topic DONE', rootId)
const opened = fake.topics.map((t) => t.title)
check('topics opened', opened, opened.length === 1)
check(
  'topic opener is the title only',
  opened[0],
  opened[0] === 'Investigate the flaky test',
)
const topicBrief = model.calls.find((entry) =>
  entry.system.includes('This topic contains a conversation about one task.'),
)?.lastUserText
check(
  'topic session brief',
  topicBrief,
  topicBrief?.includes('write down the likely cause'),
)
const reactions = marks(rootId)
check('reactions', reactions, reactions.at(-1) === 'DONE')
check('cards, patches', [fake.cards.length, fake.patches.length])
check('topic reply', sent(fake, 'after write_file'))
const workspaceFile = join(
  '.vela-data/channels/lark-oc_group/workspace/notes.md',
)
check(
  'file in group workspace',
  existsSync(workspaceFile),
  existsSync(workspaceFile),
)

// 2. Another member replies in the topic without @
let before = fake.sent.length
fake.deliver(
  larkEvent(
    {
      ...topic,
      mentions: [],
      content: JSON.stringify({ text: 'also check CI' }),
    },
    'ou_bob',
  ),
)
await until('untagged topic reply', () => fake.sent.length > before)
check('untagged topic reply', fake.sent.at(-1)?.text)

// 3. Untagged top-level chatter stays silent, and a later text answer is marked
before = fake.sent.length
const chatter = larkEvent(
  { mentions: [], content: JSON.stringify({ text: 'lunch at 12?' }) },
  'ou_bob',
)
fake.deliver(chatter)
await until('chatter settled', () =>
  marks(chatter.message.message_id).some((mark) => mark === 'OnIt(removed)'),
)
const chatterMessages = fake.sent.length - before
check('messages sent for chatter', chatterMessages, chatterMessages === 0)
const chatterMarks = marks(chatter.message.message_id)
check(
  'chatter reactions',
  chatterMarks,
  chatterMarks.every((mark) => mark.endsWith('(removed)')) &&
    !chatterMarks.includes('DONE'),
)
before = fake.sent.length
const question = larkEvent(
  { mentions: [], content: JSON.stringify({ text: 'how is the build?' }) },
  'ou_bob',
)
fake.deliver(question)
await until('passive answer', () => fake.sent.length > before)
await untilDone('passive DONE', question.message.message_id)
const passive = marks(question.message.message_id)
check('passive answer', fake.sent.at(-1)?.text)
check(
  'passive OnIt then DONE',
  passive,
  passive.some((mark) => mark === 'OnIt(removed)') &&
    passive.some((mark) => mark === 'DONE'),
)

// 4. Topic overview at top level
fake.deliver(
  larkEvent({ content: JSON.stringify({ text: '@_user_1 list topics' }) }),
)
await until('topic list', () => !!sent(fake, 'after channel_list_topics'))
check('topic list', sent(fake, 'after channel_list_topics'))

// 5. A routine in the topic, then !routines without @ (no model call)
dueMs = Math.ceil((Date.now() + 30_000) / 60_000) * 60_000
fake.deliver(
  larkEvent({
    ...topic,
    content: JSON.stringify({ text: '@_user_1 remind me in a minute' }),
  }),
)
await until('routine created', () => !!sent(fake, 'after channel_routines'))
const created = sent(fake, 'after channel_routines') ?? ''
check('routine created', created, !/error/i.test(created))
const calls = model.calls.length
fake.deliver(
  larkEvent({
    ...topic,
    mentions: [],
    content: JSON.stringify({ text: '!routines' }),
  }),
)
await until('!routines', () => !!sent(fake, 'Routines ('))
check('!routines', sent(fake, 'Routines ('))
const routineCalls = model.calls.length - calls
check('model calls for !routines', routineCalls, routineCalls === 0)

// 6. Stop before the due time, start again after it: one late delivery
await vela.dispose()
console.log('stopped; waiting past the due time')
await sleep(dueMs - Date.now() + 5_000)
fake = fakeLark()
vela = await start(fake)
await until(
  'late routine',
  () => !!sent(fake, 'Reminder: check the PR'),
  10_000,
)
await sleep(300)
const late = fake.sent
  .filter((m) => m.text.includes('Reminder'))
  .map((m) => m.text)
check('late deliveries', late, late.length === 1)
const lateNote = model.calls.some((c) => c.lastUserText.includes('late by'))
check('late note in model input', lateNote, lateNote)
const left = JSON.parse(
  readFileSync('.vela-data/channels/routines.json', 'utf8'),
).routines.length
check('one-offs left in routines.json', left, left === 0)
await vela.dispose()
console.log(failed.length ? `FAILED: ${failed.join(', ')}` : 'DONE')
process.exit(failed.length ? 1 : 0)
