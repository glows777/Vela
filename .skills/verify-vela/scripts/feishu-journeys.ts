// Offline drive of the Feishu channel journeys: topic handoff, untagged topic replies, the group
// workspace, passive top-level chatter (skip and a text answer), the topic overview and routines
// across a restart.
// The extension, gateway, files and timers are real; only the model (a router) and the Feishu
// transport are fake. Run it from a verify-vela run (up to about 2 minutes: the last step waits
// past a real due time):  $H exec $RUN feishu bun $REPO/.skills/verify-vela/scripts/feishu-journeys.ts
// It prints one line per check, marks failed checks FAIL and exits 1 if any failed; adapt the
// router and steps to the change being verified.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { feishu } from '../../../src/extensions/feishu/index.ts'
import { createVela } from '../../../src/index.ts'
import {
  createFauxModel,
  type FauxRequest,
  type FauxResponse,
} from '../../../src/testing/index.ts'
import { fakeFeishu, feishuEvent } from '../../../test/support/feishu.ts'

type Fake = ReturnType<typeof fakeFeishu>
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
/** Deployment-local YYYY-MM-DDTHH:mm, the format feishu_routines expects for a one-off. */
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
  if (/investigate/i.test(text) && req.tools.includes('feishu_start_topic'))
    return call('feishu_start_topic', {
      title: 'Investigate the flaky test',
      brief: 'Investigate the flaky test and write down the likely cause.',
    })
  if (text.includes('Investigate the flaky test'))
    return call('write_file', { path: 'notes.md', content: 'cause: timing' })
  if (/remind/i.test(text))
    return call('feishu_routines', {
      action: 'create',
      message: 'Check the PR',
      schedule: { at: local(dueMs) },
    })
  if (text.includes('Scheduled wake-up'))
    return { text: 'Reminder: check the PR' }
  if (/list topics/i.test(text)) return call('feishu_list_topics', {})
  if (/lunch/i.test(text) && req.tools.includes('feishu_skip_reply'))
    return call('feishu_skip_reply', {})
  return { text: `ok: ${text.slice(-40)}` }
}

const model = createFauxModel({
  responses: Array.from({ length: 200 }, () => router),
})
const start = async (fake: Fake) => {
  const vela = createVela({
    dataDir: '.vela-data',
    model,
    extensionConfig: { feishu: { timezone: zone } },
    extensions: [
      feishu({
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

let fake = fakeFeishu()
let vela = await start(fake)

// 1. Top-level @ hands the task to a topic
const root = feishuEvent({
  content: JSON.stringify({ text: '@_user_1 investigate the flaky test' }),
})
const rootId = root.message.message_id
const topic = { root_id: rootId, thread_id: `thread_${rootId}` }
fake.deliver(root)
await until('topic result', () => !!sent(fake, 'after write_file'))
await sleep(300)
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
const reactions = fake.reactions.map(
  (r) => `${r.emoji}${r.removed ? '(removed)' : ''}`,
)
check('reactions', reactions, reactions.at(-1) === 'DONE')
check('cards, patches', [fake.cards.length, fake.patches.length])
check('topic reply', sent(fake, 'after write_file'))
const workspaceFile = join(
  '.vela-data/channels/feishu-oc_group/workspace/notes.md',
)
check(
  'file in group workspace',
  existsSync(workspaceFile),
  existsSync(workspaceFile),
)

// 2. Another member replies in the topic without @
let before = fake.sent.length
fake.deliver(
  feishuEvent(
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
const reactionsBefore = fake.reactions.length
fake.deliver(
  feishuEvent(
    { mentions: [], content: JSON.stringify({ text: 'lunch at 12?' }) },
    'ou_bob',
  ),
)
await sleep(500)
const chatter = fake.sent.length - before
check('messages sent for chatter', chatter, chatter === 0)
const chatterReactions = fake.reactions.slice(reactionsBefore)
check(
  'chatter reactions',
  chatterReactions.map(
    (reaction) => `${reaction.emoji}${reaction.removed ? '(removed)' : ''}`,
  ),
  chatterReactions.every((reaction) => reaction.removed) &&
    chatterReactions.every((reaction) => reaction.emoji !== 'DONE'),
)
before = fake.sent.length
const answerMark = fake.reactions.length
fake.deliver(
  feishuEvent(
    { mentions: [], content: JSON.stringify({ text: 'how is the build?' }) },
    'ou_bob',
  ),
)
await until('passive answer', () => fake.sent.length > before)
const passive = fake.reactions.slice(answerMark)
check('passive answer', fake.sent.at(-1)?.text)
check(
  'passive OnIt then DONE',
  passive.map(
    (reaction) => `${reaction.emoji}${reaction.removed ? '(removed)' : ''}`,
  ),
  passive.some((reaction) => reaction.emoji === 'OnIt' && reaction.removed) &&
    passive.some((reaction) => reaction.emoji === 'DONE' && !reaction.removed),
)

// 4. Topic overview at top level
fake.deliver(
  feishuEvent({ content: JSON.stringify({ text: '@_user_1 list topics' }) }),
)
await until('topic list', () => !!sent(fake, 'after feishu_list_topics'))
check('topic list', sent(fake, 'after feishu_list_topics'))

// 5. A routine in the topic, then !routines without @ (no model call)
dueMs = Math.ceil((Date.now() + 30_000) / 60_000) * 60_000
fake.deliver(
  feishuEvent({
    ...topic,
    content: JSON.stringify({ text: '@_user_1 remind me in a minute' }),
  }),
)
await until('routine created', () => !!sent(fake, 'after feishu_routines'))
const created = sent(fake, 'after feishu_routines') ?? ''
check('routine created', created, !/error/i.test(created))
const calls = model.calls.length
fake.deliver(
  feishuEvent({
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
fake = fakeFeishu()
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
