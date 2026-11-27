// Offline drive of topic ↔ group hand-offs (#241): two @ requests open two topics, topic A
// hands its result straight to topic B, then a person asks the group for status.
import { join } from 'node:path'
import { createRuntime } from '@glows777/vela'
import {
  createFauxModel,
  type FauxRequest,
  type FauxResponse,
} from '@glows777/vela/testing'
import { DaemonLarkHost } from '../../../packages/vela/src/legacy-desktop.ts'
import { silentLogger } from '../../../packages/vela/src/shared/logger.ts'
import { fakeLark, larkEvent } from '../../../test/support/lark.ts'
import { prepareWorkspace } from './workspace.ts'

prepareWorkspace()

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

function router(req: FauxRequest): FauxResponse {
  const text = req.lastUserText
  const lastTool = req.toolResults.at(-1)
  if (req.tools.includes('session_start')) {
    if (/status\?/.test(text)) return { text: 'Both topics are done.' }
    if (lastTool) return { text: '' }
    if (/release confirmation/.test(text))
      return call('session_start', {
        title: 'Release confirmation',
        brief:
          'Prepare the release confirmation; topic "Find the code" supplies the code.',
      })
    if (/verification code/.test(text))
      return call('session_start', {
        title: 'Find the code',
        brief:
          'Find the release verification code and give it to the "Release confirmation" topic.',
      })
    return { text: 'Both topics are done.' }
  }
  if (text.startsWith('Message from Vela'))
    return { text: 'Release confirmed with ORBIT-73.' }
  if (text.includes('Prepare the release confirmation'))
    return { text: 'Waiting for the code.' }
  if (lastTool?.toolName === 'session_list') {
    const parsed = JSON.parse(lastTool.output) as {
      sessions: { id: string; name?: string | null; title?: string | null }[]
    }
    const target = parsed.sessions.find(
      (s) =>
        s.name === 'Release confirmation' || s.title === 'Release confirmation',
    )
    if (!target) throw new Error('Release confirmation session not found')
    return call('session_message', {
      target: target.id,
      text: 'The release verification code is ORBIT-73.',
    })
  }
  if (lastTool?.toolName === 'session_message')
    return { text: 'Gave the code to the release topic.' }
  return call('session_list', {})
}

const model = createFauxModel({
  responses: Array.from({ length: 50 }, () => router),
})
const fake = fakeLark()
const agentDir = join(process.cwd(), '.vela-data-handoff')
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
try {
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
  fake.deliver(
    larkEvent({
      message_id: 'group_b',
      content: '{"text":"@_user_1 prepare the release confirmation"}',
    }),
  )
  await until('B answers', () =>
    fake.topics.some((item) => item.title.includes('Waiting for the code')),
  )
  fake.deliver(
    larkEvent({
      message_id: 'group_a',
      content: '{"text":"@_user_1 find the release verification code"}',
    }),
  )
  await until('B confirms', () =>
    fake.topics.some((item) => item.title.includes('Release confirmed')),
  )
  await sleep(100)
  const calls = model.calls.length
  const visible = [
    ...fake.sent.map((m) => m.text),
    ...fake.topics.map((t) => t.title),
  ]
  check(
    'topics opened',
    fake.topics.map((topic) => topic.title),
    fake.topics.some((t) => t.title === 'Release confirmation') &&
      fake.topics.some((t) => t.title === 'Find the code'),
  )
  check(
    'A first input has the original message',
    model.calls.find((req) => req.lastUserText.includes('Find the release'))
      ?.lastUserText,
    !!model.calls.some((req) =>
      req.lastUserText.includes('find the release verification code'),
    ),
  )
  check(
    'visible messages',
    visible,
    !visible.some((text) => text.includes('verification code is')),
  )
  check('forwards for the hop', fake.forwards, fake.forwards.length === 0)
  const note = model.calls.find((req) =>
    req.lastUserText.startsWith('Message from Vela'),
  )
  check('B received the note', note?.lastUserText, !!note)

  fake.deliver(larkEvent({ content: '{"text":"@_user_1 status?"}' }))
  await until('status answer', () =>
    fake.sent.some((item) => item.text.includes('Both topics are done')),
  )
  check('model calls between the topics finishing and the question', calls)
} catch (error) {
  check('journey', String(error), false)
} finally {
  await host.stop()
  await runtime.dispose()
}
console.log(failed.length ? `FAILED: ${failed.join(', ')}` : 'DONE')
process.exit(failed.length ? 1 : 0)
