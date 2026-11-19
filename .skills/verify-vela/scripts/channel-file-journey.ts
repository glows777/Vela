// Exercise the public SDK in a disposable workspace with a scripted model and an offline Lark transport.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createVela } from '@glows777/vela'
import { drainChannels } from '@glows777/vela-channels/testing'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'
import { lark } from '@glows777/vela-lark'
import { fakeLark, larkEvent } from '../../../test/support/lark.ts'
import { prepareWorkspace } from './workspace.ts'

prepareWorkspace()
const fake = fakeLark()
const posted: string[] = []
fake.transport.sendFile = async (chat, file, options) => {
  assert.equal(chat, 'oc_group')
  assert.equal(options?.replyToId, 'report-root')
  assert.equal(options?.replyInThread, true)
  assert.equal(new TextDecoder().decode(file.bytes), 'report fixture')
  posted.push(file.name)
  return { messageId: 'attachment', createTime: '1' }
}
const model = createFauxModel({
  responses: Array.from({ length: 4 }, () => (request) => {
    const result = request.toolResults.at(-1)
    if (result) return fauxText(result.output)
    assert(request.tools.includes('channel_send_file'))
    const path = request.lastUserText.includes('missing.md')
      ? 'missing.md'
      : 'out/report.patch'
    return fauxToolCall('channel_send_file', { path })
  }),
})
const vela = createVela({
  model,
  dataDir: '.vela-data',
  extensions: [
    lark({ transport: fake.transport, chats: ['oc_group'], owners: [] }),
  ],
})
try {
  await vela.startChannels()
  const workspace = join(vela.dataDir, 'channels/lark-oc_group/workspace')
  await mkdir(join(workspace, 'out'), { recursive: true })
  await writeFile(join(workspace, 'out/report.patch'), 'report fixture')
  const finished: string[] = []
  vela.channel('lark').onSession(({ run }) => {
    if (run?.type === 'finished') finished.push(run.outcome)
  })
  for (const [path, prompt] of [
    [
      'out/report.patch',
      'The report is out/report.patch. Send me the report as a file.',
    ],
    ['missing.md', 'Send missing.md as a file.'],
  ] as const) {
    const start = fake.sent.length
    fake.deliver(
      larkEvent({
        root_id: 'report-root',
        thread_id: 'report-thread',
        content: JSON.stringify({ text: prompt }),
      }),
    )
    await drainChannels(vela)
    const replies = fake.sent.slice(start)
    assert.equal(replies.length, 1)
    assert.equal(finished.at(-1), 'done')
    const result = model.calls.at(-1)?.toolResults.at(-1)
    assert.equal(result?.toolName, 'channel_send_file')
    assert(replies[0]!.text.includes(result.output))
    assert(!replies[0]!.text.includes('\n'))
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
  await vela.dispose()
}
