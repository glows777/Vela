// Offline drive of the hub execution tools (#421): a Lark group session runs a one-step command
// itself, starts a background command whose exit is answered in the main timeline, still dispatches
// a longer task to a topic, and a DM keeps neither bash nor the background tools.
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
  if (/investigate/i.test(text) && req.tools.includes('session_start'))
    return call('session_start', {
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
  const agentDir = join(process.cwd(), '.vela-data-hub-tools')
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
        chats: ['oc_group'],
      },
    },
    true,
  )
  return { runtime, host }
}
const sent = (fake: Fake, part: string) =>
  fake.sent.find((message) => message.text.includes(part))?.text ??
  fake.topics.find((topic) => topic.title.includes(part))?.title

const fake = fakeLark()
const { runtime, host } = await start(fake)

try {
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
  const waitsInHub = hubTools.includes('wait_for_input')
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
    'exit reply delivered to the group',
    fake.sent.at(-1),
    fake.sent.at(-1)?.text === 'exit answered in the group',
  )
  const exitInput = model.calls.at(-1)?.lastUserText
  check(
    'exit reached the model',
    exitInput?.slice(0, 60),
    exitInput?.startsWith('Background command bg-1 finished'),
  )
  check(
    'exit carried the output',
    exitInput?.includes('BACKGROUND_READY'),
    true,
  )

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
    fake.topics.some((topic) => topic.title === 'Investigate the flake'),
  )
  const topicTools = model.calls.find((entry) =>
    entry.system.includes('This session works on one task inside a project.'),
  )?.tools
  check(
    'topic tools',
    topicTools?.filter((name) => /^(bash|background_)/.test(name)),
    ['bash', 'background_output', 'background_stop'].every((name) =>
      (topicTools ?? []).includes(name),
    ) && !(topicTools ?? []).includes('background_start'),
  )

  // 4. A DM keeps execution tools and background tools in Runtime
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
  check(
    'dm execution tools',
    dmTools.filter((name) => /^(bash|write|edit)$/.test(name)),
    ['bash', 'write', 'edit'].every((name) => dmTools.includes(name)),
  )
  const dmBackground = dmTools.filter((name) => name.startsWith('background_'))
  check(
    'dm background tools',
    dmBackground,
    ['background_output', 'background_stop'].every((n) =>
      dmBackground.includes(n),
    ),
  )
} finally {
  await host.stop()
  await runtime.dispose()
}
console.log(failed.length ? `FAILED: ${failed.join(', ')}` : 'DONE')
process.exit(failed.length ? 1 : 0)
