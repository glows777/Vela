// Offline drive of the hub execution tools (#421): a Lark group session runs a one-step command
// itself, starts a background command whose exit is answered in the main timeline, still dispatches
// a longer task to a topic, and a DM keeps neither bash nor the background tools.
// The extension, gateway, files and child processes are real; only the model (a router) and the
// Lark transport are fake. Run it from a verify-vela run:
//   $H exec $RUN hub-tools bun $REPO/.skills/verify-vela/scripts/hub-tools-journey.ts
// It prints one line per check, marks failed checks FAIL and exits 1 if any failed.
import { createVela } from '@glows777/vela'
import {
  createFauxModel,
  type FauxRequest,
  type FauxResponse,
} from '@glows777/vela/testing'
import { background } from '../../../packages/vela/src/driver/extensions/background/index.ts'
import { lark } from '../../../packages/vela/src/lark/index.ts'
import { fakeLark, larkEvent } from '../../../test/support/lark.ts'
import { prepareWorkspace } from './workspace.ts'

prepareWorkspace()

type Fake = ReturnType<typeof fakeLark>
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

/** Answer by request shape and message, so the hub, its topic and the DM never race a queue. */
function router(req: FauxRequest): FauxResponse {
  const last = req.toolResults.at(-1)
  const text = req.lastUserText
  const call = (name: string, input: unknown): FauxResponse => ({
    toolCalls: [{ name, input }],
  })
  if (text.startsWith('Background command'))
    return { text: 'exit answered in the group' }
  if (last?.toolName === 'bash')
    return {
      text: /Command running in background with ID:/.test(last.output)
        ? 'started slow check'
        : 'hub ran bash',
    }
  if (last) return { text: `after ${last.toolName}` }
  if (/run gh/i.test(text)) return call('bash', { command: 'echo HUB_TOOL_OK' })
  if (/start slow check/i.test(text))
    return call('bash', {
      command: 'sleep 0.6; echo BACKGROUND_READY',
      run_in_background: true,
    })
  if (/status now/i.test(text)) return { text: 'still running' }
  if (/investigate/i.test(text) && req.tools.includes('channel_start_topic'))
    return call('channel_start_topic', {
      title: 'Investigate the flake',
      brief: 'Investigate the flaky test and report the likely cause.',
    })
  if (text.includes('Investigate the flaky test'))
    return { text: 'topic finished' }
  return { text: `ok: ${text.slice(-40)}` }
}

const model = createFauxModel({
  responses: Array.from({ length: 200 }, () => router),
})
const start = async (fake: Fake) => {
  const vela = createVela({
    dataDir: '.vela-data',
    model,
    extensions: [
      background(),
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

const fake = fakeLark()
const vela = await start(fake)

// 1. A quick one-step command runs in the group session itself
fake.deliver(
  larkEvent({
    message_id: 'hub-gh',
    content: '{"text":"@_user_1 run gh pr view"}',
  }),
)
await until('hub bash reply', () => !!sent(fake, 'hub ran bash'))
const hubTools = model.calls[0]!.tools
check(
  'hub tools',
  hubTools.filter((name) => /^(bash|write|edit|background_)/.test(name)),
  ['bash', 'write', 'edit', 'background_output', 'background_stop'].every(
    (name) => hubTools.includes(name),
  ) && !hubTools.includes('background_start'),
)
const waitsInHub = hubTools.includes('channel_wait_for_input')
check('no waiting tool in the hub', waitsInHub, !waitsInHub)
check(
  'no topic opened for a quick command',
  fake.topics.length,
  fake.topics.length === 0,
)
const bashResult = model.calls
  .flatMap((entry) => entry.toolResults)
  .find((result) => result.toolName === 'bash')?.output
check('hub bash output', bashResult, bashResult?.includes('HUB_TOOL_OK'))

// 2. A command that may keep running starts in the background: the hub keeps answering
fake.deliver(
  larkEvent({
    message_id: 'hub-bg',
    content: '{"text":"@_user_1 start slow check"}',
  }),
)
await until('start reply', () => !!sent(fake, 'started slow check'))
fake.deliver(
  larkEvent({
    message_id: 'hub-status',
    content: '{"text":"@_user_1 status now"}',
  }),
)
await until('status reply', () => !!sent(fake, 'still running'))
await until(
  'exit reply',
  () => !!sent(fake, 'exit answered in the group'),
  10_000,
)
check(
  'exit reply anchors on the last person message',
  fake.sent.at(-1),
  fake.sent.at(-1)?.messageId === 'hub-status',
)
const exitInput = model.calls.at(-1)?.lastUserText
check(
  'exit reached the model',
  exitInput?.slice(0, 60),
  exitInput?.startsWith('Background command bg-1 finished'),
)
check('exit carried the output', exitInput?.includes('BACKGROUND_READY'), true)

// 3. A longer task still becomes a topic, which keeps the same execution tools
fake.deliver(
  larkEvent({
    message_id: 'hub-work',
    content: '{"text":"@_user_1 investigate the flake"}',
  }),
)
await until('topic reply', () => !!sent(fake, 'topic finished'))
check(
  'topics opened',
  fake.topics.map((topic) => topic.title),
  fake.topics.length === 1,
)
const topicTools = model.calls.find((entry) =>
  entry.system.includes('This topic contains a conversation about one task.'),
)?.tools
check(
  'topic tools',
  topicTools?.filter((name) => /^(bash|background_)/.test(name)),
  ['bash', 'background_output', 'background_stop'].every((name) =>
    (topicTools ?? []).includes(name),
  ) && !(topicTools ?? []).includes('background_start'),
)

// 4. A DM keeps no execution or background tools
fake.deliver(
  larkEvent(
    {
      chat_id: 'oc_dm',
      chat_type: 'p2p',
      message_id: 'dm',
      content: '{"text":"hi"}',
    },
    'ou_alice',
  ),
)
await until('dm reply', () => !!sent(fake, 'ok: Alice: hi'))
const dmTools = model.calls.at(-1)!.tools
// A DM keeps its execution tools and gets no background tools, unchanged by this change.
check(
  'dm execution tools',
  dmTools.filter((name) => /^(bash|write|edit)$/.test(name)),
  ['bash', 'write', 'edit'].every((name) => dmTools.includes(name)),
)
const dmBackground = dmTools.filter((name) => name.startsWith('background_'))
check('dm background tools', dmBackground, dmBackground.length === 0)

await vela.dispose()
console.log(failed.length ? `FAILED: ${failed.join(', ')}` : 'DONE')
process.exit(failed.length ? 1 : 0)
