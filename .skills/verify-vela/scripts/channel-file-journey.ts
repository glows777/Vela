// Exercise the public Runtime SDK in a disposable workspace with a scripted model and an offline Lark transport.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRuntime } from '@glows777/vela'
import { DaemonLarkHost } from '../../../packages/vela/src/daemon/lark-host.ts'
import { silentLogger } from '../../../packages/vela/src/shared/logger.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../../packages/vela/src/testing/core/index.ts'
import { fakeLark, larkEvent } from '../../../test/support/lark.ts'
import { prepareWorkspace } from './workspace.ts'

prepareWorkspace()
const fake = fakeLark()
const posted: string[] = []
let postedCallback: (() => void) | undefined
fake.transport.sendFile = async (chat, file, options) => {
  assert.equal(chat, 'oc_group')
  assert.equal(options?.replyToId, 'report-root')
  assert.equal(options?.replyInThread, true)
  assert.equal(new TextDecoder().decode(file.bytes), 'report fixture')
  posted.push(file.name)
  postedCallback?.()
  return { messageId: 'attachment', createTime: '1' }
}
const model = createFauxModel({
  responses: Array.from({ length: 4 }, () => (request) => {
    const result = request.toolResults.at(-1)
    if (result) return fauxText(result.output)
    assert(request.tools.includes('send_file'))
    const path = request.lastUserText.includes('missing.md')
      ? 'missing.md'
      : 'out/report.patch'
    return fauxToolCall('send_file', { path })
  }),
})
const agentDir = join(process.cwd(), '.vela-data-channel-file')
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
const finished: string[] = []
const unsub = runtime.events.subscribe((event) => {
  if (event.type === 'run_finished') finished.push(event.status)
})
try {
  await runtime.ready()
  await host.sync(
    {
      lark: {
        appId: 'bot',
        chats: ['oc_group'],
        owners: [],
      },
    },
    true,
  )
  const workspace = join(agentDir, 'channels/lark/oc_group/workspace')
  await mkdir(join(workspace, 'out'), { recursive: true })
  await writeFile(join(workspace, 'out/report.patch'), 'report fixture')
  const waitUntil = async (what: string, pred: () => boolean) => {
    const deadline = Date.now() + 5_000
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timeout: ${what}`)
      await new Promise((done) => setTimeout(done, 10))
    }
  }
  for (const [path, prompt] of [
    [
      'out/report.patch',
      'The report is out/report.patch. Send me the report as a file.',
    ],
    ['missing.md', 'Send missing.md as a file.'],
  ] as const) {
    const startSent = fake.sent.length
    const startPosted = posted.length
    let postedDone = path !== 'out/report.patch'
    postedCallback = () => {
      postedDone = true
    }
    fake.deliver(
      larkEvent({
        root_id: 'report-root',
        thread_id: 'thread_report-root',
        content: JSON.stringify({ text: `@_user_1 ${prompt}` }),
      }),
    )
    await waitUntil(
      `reply for ${path}`,
      () => postedDone && fake.sent.length > startSent,
    )
    if (path === 'out/report.patch') {
      assert.equal(posted.length, startPosted + 1)
    }
    const replies = fake.sent.slice(startSent)
    assert.equal(replies.length, 1)
    assert.equal(finished.at(-1), 'completed')
    const result = model.calls.at(-1)?.toolResults.at(-1)
    assert.equal(result?.toolName, 'send_file')
    assert(replies[0]!.text.includes(result.output))
    if (path === 'missing.md') assert.match(result.output, /not found/i)
    console.log(
      JSON.stringify({
        model: 'scripted faux',
        prompt,
        tool: result.toolName,
        path,
        reply: replies[0]!.text,
        outcome: finished.at(-1),
      }),
    )
  }
  assert.deepEqual(posted, ['report.patch'])
  assert.equal(model.calls[0]!.system, model.calls[2]!.system)
  assert.deepEqual(model.calls[0]!.tools, model.calls[2]!.tools)
} finally {
  unsub()
  await host.stop()
  await runtime.dispose()
}
