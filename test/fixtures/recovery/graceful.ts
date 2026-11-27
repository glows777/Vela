import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestVela } from '@glows777/vela/testing'
import { z } from 'zod'
import { lark } from '../../../packages/vela/src/lark/index.ts'
import {
  fauxText,
  fauxToolCall,
} from '../../../packages/vela/src/testing/core/index.ts'
import { fakeLark, larkEvent } from '../../support/lark.ts'
import { runServe } from './serve-helper.ts'

const [cwd, mode] = process.argv.slice(2) as [string, string]
const fake = fakeLark()
const report = (name: string, value: unknown) =>
  writeFileSync(join(cwd, name), JSON.stringify(value))
const t = createTestVela({
  cwd,
  responses:
    mode === 'resume'
      ? [
          (request) => {
            report('recovered-request.json', request)
            return fauxText('RECOVERED')
          },
        ]
      : [
          mode === 'queued'
            ? [
                fauxToolCall('graceful_gate', {}),
                fauxToolCall('graceful_forbidden', {}),
              ]
            : fauxToolCall(
                mode === 'stream' ? 'graceful_forbidden' : 'graceful_gate',
                {},
              ),
          () => {
            report('unexpected-model.json', true)
            return fauxToolCall('graceful_forbidden', {})
          },
          fauxText('UNEXPECTED'),
        ],
  extensions: [
    lark({
      owners: ['ou_alice'],
      chats: ['oc_group'],
      transport: fake.transport,
    }),
    function graceful(api) {
      api.registerTool({
        name: 'gate',
        executionMode: 'sequential',
        inputSchema: z.object({}),
        description: 'An in-flight operation.',
        execute: async (_input, context) => {
          appendFileSync(join(cwd, 'executions'), 'executed\n')
          report('tool-started.json', true)
          while (!existsSync(join(cwd, 'release'))) {
            context?.signal?.throwIfAborted()
            await Bun.sleep(10)
          }
          report('tool-finished.json', true)
          return 'DURABLE TOOL RESULT'
        },
      })
      api.registerTool({
        name: 'forbidden',
        executionMode: 'sequential',
        description: 'Must not execute during shutdown.',
        inputSchema: z.object({}),
        execute: async () => {
          report('forbidden.json', true)
          return 'forbidden'
        },
      })
    },
  ],
})
if (mode === 'stream') {
  const original = t.model.doStream.bind(t.model)
  t.model.doStream = async (options) => {
    const result = await original(options)
    let first = true
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          async transform(chunk, controller) {
            if (first) {
              first = false
              report('model-stream-started.json', true)
              while (!existsSync(join(cwd, 'release'))) await Bun.sleep(10)
            }
            controller.enqueue(chunk)
          },
        }),
      ),
    }
  }
}
await t.vela.ready()
const serving = runServe({
  vela: t.vela,
  write: (line) => appendFileSync(join(cwd, 'serve.log'), `${line}\n`),
})
while (!t.vela.runningChannels().length) await Bun.sleep(5)
const deliver = (id: string) =>
  fake.deliver(
    larkEvent({
      message_id: id,
      root_id: 'root',
      thread_id: 'thread',
      content: JSON.stringify({ text: id }),
    }),
  )
if (mode !== 'resume') {
  process.once('SIGTERM', () => {
    setTimeout(() => {
      deliver('NEW TASK AFTER SIGTERM')
      report('new-task-attempted.json', true)
    }, 50)
  })
  deliver('original task')
} else {
  while (!fake.sent.some((message) => message.text.includes('RECOVERED')))
    await Bun.sleep(5)
  process.kill(process.pid, 'SIGTERM')
}
const code = await serving
await t.vela.dispose()
report('model-calls.json', t.model.calls)
report('events.json', t.events)
report('sent.json', fake.sent)
process.exit(code)
