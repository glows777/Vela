// Offline drive of the Lark channel journeys: topic handoff, untagged topic replies, group
// workspace, passive chatter (skip and reply), topic overview, and timers across a restart.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRuntime } from '@glows777/vela'
import {
  createFauxModel,
  type FauxRequest,
  type FauxResponse,
} from '@glows777/vela/testing'
import { DaemonLarkHost } from '../../../packages/vela/src/daemon/lark-host.ts'
import { silentLogger } from '../../../packages/vela/src/shared/logger.ts'
import { fakeLark, larkEvent } from '../../../test/support/lark.ts'
import { prepareWorkspace } from './workspace.ts'

prepareWorkspace()

type Fake = ReturnType<typeof fakeLark>
const zone = 'Asia/Shanghai'
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

let dueMs = 0

function router(req: FauxRequest): FauxResponse {
  const last =
    req.prompt.at(-1)?.role === 'tool' ? req.toolResults.at(-1) : undefined
  if (last?.toolName === 'skip_reply') return { text: '' }
  if (last)
    return { text: `after ${last.toolName}: ${last.output.slice(0, 80)}` }
  const text = req.lastUserText
  const call = (name: string, input: unknown): FauxResponse => ({
    toolCalls: [{ name, input }],
  })
  if (/list topics/i.test(text)) return call('session_list', {})
  if (/remind/i.test(text))
    return call('timers', {
      action: 'create',
      message: 'Check the PR',
      schedule: { at: local(dueMs) },
    })
  if (/lunch/i.test(text) && req.tools.includes('skip_reply'))
    return call('skip_reply', {})
  if (/investigate/i.test(text) && req.tools.includes('session_start'))
    return call('session_start', {
      title: 'Investigate the flaky test',
      brief: 'Investigate the flaky test and write down the likely cause.',
    })
  if (text.includes('Investigate the flaky test'))
    return call('write', { path: 'notes.md', content: 'cause: timing' })
  if (text.includes('[Scheduled routine]'))
    return { text: 'Reminder: check the PR' }
  return { text: `ok: ${text.slice(-40)}` }
}

const model = createFauxModel({
  responses: Array.from({ length: 200 }, () => router),
})
const agentDir = join(process.cwd(), '.vela-data-lark')
const start = async (fake: Fake) => {
  const runtime = createRuntime({
    agentDir,
    defaultModel: model,
    mcp: false,
  })
  const host = new DaemonLarkHost(runtime, {
    agentDir,
    hostEnv: {},
    logger: silentLogger,
    transport: fake.transport,
  })
  await runtime.ready()
  await host.sync(
    {
      lark: {
        appId: 'bot',
        owners: ['ou_alice'],
        chats: [{ id: 'oc_group', readUntagged: true }],
        timezone: zone,
      },
    },
    true,
  )
  return { runtime, host }
}
const sent = (fake: Fake, part: string) =>
  fake.sent.find((message) => message.text.includes(part))?.text ??
  fake.topics.find((topic) => topic.title.includes(part))?.title

let fake = fakeLark()
let { runtime, host } = await start(fake)
const marks = (messageId: string) =>
  fake.reactions
    .filter((reaction) => reaction.messageId === messageId)
    .map(
      (reaction) => `${reaction.emoji}${reaction.removed ? '(removed)' : ''}`,
    )
const untilDone = (what: string, messageId: string) =>
  until(what, () => marks(messageId).includes('DONE'))

// 1. Top-level @ hands the task to a topic
const root = larkEvent({
  content: JSON.stringify({ text: '@_user_1 investigate the flaky test' }),
})
const rootId = root.message.message_id
const topic = { root_id: rootId, thread_id: `thread_${rootId}` }
fake.deliver(root)
await until('topic result', () => !!sent(fake, 'after write'))
await untilDone('topic DONE', rootId)
const opened = fake.topics.map((t) => t.title)
check('topics opened', opened, opened.includes('Investigate the flaky test'))
check(
  'topic opener is the title only',
  opened[0],
  opened[0] === 'Investigate the flaky test',
)
const topicBrief = model.calls.find((entry) =>
  entry.system.includes('This session works on one task inside a project.'),
)?.lastUserText
check(
  'topic session brief',
  topicBrief,
  topicBrief?.includes('write down the likely cause'),
)
const reactions = marks(rootId)
check('reactions', reactions, reactions.at(-1) === 'DONE')
check('topic reply', sent(fake, 'after write'))
const workspaceFile = join(
  agentDir,
  'channels/lark/oc_group/workspace/notes.md',
)
check(
  'file in group workspace',
  existsSync(workspaceFile),
  existsSync(workspaceFile),
)

// 2. Another member replies in the topic without @
const beforeTopics = fake.topics.length
const beforeSent = fake.sent.length
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
await until(
  'untagged topic reply',
  () => fake.topics.length > beforeTopics || fake.sent.length > beforeSent,
)
check(
  'untagged topic reply',
  fake.sent.length > beforeSent
    ? fake.sent.at(-1)?.text
    : fake.topics.at(-1)?.title,
)

// 3. Untagged top-level chatter stays silent, and a later text answer is marked
let sentBefore = fake.sent.length
const chatter = larkEvent(
  { mentions: [], content: JSON.stringify({ text: 'lunch at 12?' }) },
  'ou_bob',
)
fake.deliver(chatter)
await until('chatter settled', () =>
  model.calls.some((c) =>
    c.toolResults.some((r) => r.toolName === 'skip_reply'),
  ),
)
await sleep(100)
const chatterMessages = fake.sent.length - sentBefore
check('messages sent for chatter', chatterMessages, chatterMessages === 0)
const chatterMarks = marks(chatter.message.message_id)
check('chatter reactions', chatterMarks, !chatterMarks.includes('DONE'))
sentBefore = fake.sent.length
const question = larkEvent(
  { mentions: [], content: JSON.stringify({ text: 'how is the build?' }) },
  'ou_bob',
)
fake.deliver(question)
await until('passive answer', () => fake.sent.length > sentBefore)
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
await until('topic list', () => !!sent(fake, 'after session_list'))
check('topic list', sent(fake, 'after session_list'))

// 5. A routine in the topic, then !timers without @ (no model call)
dueMs = Math.ceil((Date.now() + 30_000) / 60_000) * 60_000
fake.deliver(
  larkEvent({
    ...topic,
    content: JSON.stringify({ text: '@_user_1 remind me in a minute' }),
  }),
)
await until('routine created', () => !!sent(fake, 'after timers'))
const created = sent(fake, 'after timers') ?? ''
check('routine created', created, !/error/i.test(created))
const calls = model.calls.length
fake.deliver(
  larkEvent({
    ...topic,
    mentions: [],
    content: JSON.stringify({ text: '!timers' }),
  }),
)
await until('!timers', () => !!sent(fake, 'Check the PR'))
check('!timers', sent(fake, 'Check the PR'))
const routineCalls = model.calls.length - calls
check('model calls for !timers', routineCalls, routineCalls === 0)

// 6. Stop before the due time, start again after it: one late delivery
await host.stop()
await runtime.dispose()
console.log('stopped; waiting past the due time')
await sleep(Math.max(0, dueMs - Date.now()) + 5_000)
fake = fakeLark()
;({ runtime, host } = await start(fake))
await until(
  'late routine',
  () => !!sent(fake, 'Reminder: check the PR'),
  10_000,
)
await sleep(300)
const late = [
  ...fake.sent.map((m) => m.text),
  ...fake.topics.map((t) => t.title),
].filter((text) => text.includes('Reminder'))
check('late deliveries', late, late.length === 1)
const lateNote = model.calls.some((c) =>
  c.lastUserText.includes('[Scheduled routine]'),
)
check('routine catch-up in model input', lateNote, lateNote)
const remaining = (await runtime.timers.list({ enabledOnly: true })).filter(
  (t) => t.kind === 'routine',
)
check('one-offs left after firing', remaining.length, remaining.length === 0)
await host.stop()
await runtime.dispose()
console.log(failed.length ? `FAILED: ${failed.join(', ')}` : 'DONE')
process.exit(failed.length ? 1 : 0)
