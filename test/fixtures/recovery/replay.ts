import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createTestVela,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'
import { z } from 'zod'

const [cwd, mode, policy = 'safe'] = process.argv.slice(2)
if (!cwd || !mode) throw new Error('Expected cwd and mode')
const t = createTestVela({
  cwd,
  sessionId: 'replay',
  responses:
    mode === 'start'
      ? [
          fauxToolCall(
            'replay_probe',
            { path: 'read-only-resource' },
            { id: 'original-call' },
          ),
        ]
      : [
          (request) => {
            writeFileSync(
              join(cwd, 'recovered-request.json'),
              JSON.stringify(request),
            )
            return fauxText('recovery complete')
          },
        ],
  extensions: [
    function replay(api) {
      api.registerTool({
        name: 'probe',
        description: 'Read a resource; test instrumentation counts attempts',
        inputSchema: z.object({ path: z.string() }),
        replay: policy === 'safe' ? 'safe' : 'unsafe',
        execute: async (_input, context) => {
          // This marker is test instrumentation, not the replay-safe operation's payload.
          appendFileSync(
            join(cwd, 'attempts.jsonl'),
            `${JSON.stringify({ id: context?.toolCallId })}\n`,
          )
          if (mode === 'complete') return 'resource read successfully'
          console.log('CALL_READY')
          return new Promise(() => {})
        },
      })
    },
  ],
})
const keepAlive = setInterval(() => {}, 1000)
try {
  if (mode === 'start') await t.session.prompt('Read the resource')
  else {
    if (!(await t.session.resume())) throw new Error('Saved session missing')
    await t.session.continueInterrupted()
  }
  await t.session.save()
  writeFileSync(
    join(cwd, 'recovered-messages.json'),
    JSON.stringify(t.session.messages),
  )
  console.log('RECOVERY_DONE')
} finally {
  clearInterval(keepAlive)
  await t.cleanup({ keepDir: true })
}
