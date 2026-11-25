import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  createTestVela,
  fauxText,
  fauxToolCall,
} from '../../../packages/vela/src/testing/core/index.ts'

const [cwd, mode] = process.argv.slice(2)
if (!cwd) throw new Error('Expected workspace')
let searchSaved = false
let holdStarted = false
let announced = false
const announce = () => {
  if (!announced && searchSaved && holdStarted) {
    announced = true
    console.log('SEARCH_SAVED')
  }
}
const t = createTestVela({
  cwd,
  sessionId: 'search-recovery',
  responses:
    mode === 'start'
      ? [
          [
            fauxToolCall('tool_search', { query: 'searchfixture_lookup' }),
            fauxToolCall('searchfixture_hold', {}),
          ],
        ]
      : [
          (request) => {
            writeFileSync(
              join(cwd, 'search-request.json'),
              JSON.stringify(request),
            )
            return fauxText('recovered search')
          },
        ],
  extensions: [
    function searchfixture(api) {
      api.registerTool({
        name: 'lookup',
        description: 'Look up a deferred resource',
        exposure: 'deferred',
        inputSchema: z.object({}),
        execute: async () => 'resource',
      })
      api.registerTool({
        name: 'hold',
        description: 'Hold the step open',
        inputSchema: z.object({}),
        execute: async () => {
          holdStarted = true
          announce()
          return new Promise(() => {})
        },
      })
    },
  ],
})
t.session.subscribe((event) => {
  if (event.type === 'tool_execution_end' && event.toolName === 'tool_search') {
    searchSaved = true
    announce()
  }
})
const keepAlive = setInterval(() => {}, 1000)
try {
  if (mode === 'start') await t.session.prompt('Find the lookup tool')
  else {
    if (!(await t.session.resume())) throw new Error('No session')
    await t.session.continueInterrupted()
    console.log('RECOVERED')
  }
} finally {
  clearInterval(keepAlive)
  await t.cleanup({ keepDir: true })
}
