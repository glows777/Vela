import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createTestVela } from '@glows777/vela/testing'
import { z } from 'zod'
import { openDatabase } from '../../../packages/vela/src/db/sqlite.ts'
import {
  createFauxModel,
  fauxHang,
  fauxText,
  fauxToolCall,
} from '../../../packages/vela/src/testing/core/index.ts'

const [cwd, phase] = process.argv.slice(2)
const hosted =
  phase === 'hosted'
    ? createFauxModel({ responses: [fauxText('Hosted answer'), fauxHang()] })
    : undefined
if (hosted) {
  const stream = hosted.doStream.bind(hosted)
  let injected = false
  hosted.doStream = async (options) => {
    const result = await stream(options)
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            controller.enqueue(part)
            if (!injected && part.type === 'stream-start') {
              injected = true
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'hosted-search-1',
                toolName: 'web_search',
                input: '{"query":"answer"}',
                providerExecuted: true,
              })
              controller.enqueue({
                type: 'tool-result',
                toolCallId: 'hosted-search-1',
                toolName: 'web_search',
                result: { content: '42' },
              })
            }
          },
        }),
      ),
    }
  }
}
const t = createTestVela({
  cwd,
  model: hosted,
  responses: phase?.startsWith('repair')
    ? []
    : [[fauxToolCall('probe_finish', {}), fauxToolCall('probe_wait', {})]],
  extensions: [
    function probe(api) {
      api.registerTool({
        name: 'finish',
        description: 'Finish a sibling and record an effect',
        inputSchema: z.object({}),
        execute: async () => {
          appendFileSync(join(cwd!, 'effects.txt'), 'finished\n')
          return 'native response'
        },
      })
      api.registerTool({
        name: 'wait',
        description: 'Hold an interrupted sibling',
        inputSchema: z.object({}),
        ...(phase === 'legacy' ? { replay: 'safe' as const } : {}),
        execute: async () => {
          appendFileSync(join(cwd!, 'started.txt'), 'started\n')
          return new Promise(() => {})
        },
      })
      api.on('tool_result', (event) => {
        if (event.toolName === 'probe_finish')
          return { output: 'EXACT POST-HOOK RESPONSE' }
      })
    },
  ],
})
if (hosted) {
  await t.run('Search once')
  void t.run('Continue the next task')
  while (hosted.calls.length < 2) await Bun.sleep(5)
  await t.session.save()
  console.log('CRASH_READY')
} else if (phase?.startsWith('repair')) {
  await t.session.resume()
  t.model.doStream = () => {
    console.log('CRASH_READY')
    return new Promise<never>(() => {})
  }
  void t.session.continueInterrupted()
} else {
  void t.run('Finish both siblings exactly once')
  const historySaved = () => {
    const dbPath = join(t.vela.dataDir, 'vela.db')
    if (!existsSync(dbPath)) return false
    const db = openDatabase({ path: dbPath, readonly: true })
    try {
      const row = db.get<{ c: number }>(
        "SELECT COUNT(*) AS c FROM vela_tool_calls WHERE status = 'completed' AND result_json LIKE '%EXACT POST-HOOK RESPONSE%'",
      )
      return (row?.c ?? 0) > 0
    } catch {
      return false
    } finally {
      db.close()
    }
  }
  while (!existsSync(join(cwd!, 'started.txt')) || !historySaved())
    await Bun.sleep(5)
  console.log('CRASH_READY')
}
setInterval(() => {}, 1000)
