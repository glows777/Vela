/**
 * Subscribe to session events (pi's shape): streamed text, tool calls and results, usage and the end of the run.
 *
 * The faux model first asks for the `read_file` tool, then answers. The tool really runs,
 * against a temporary working directory created here.
 *
 * Run: bun examples/sdk/02-events.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVela } from '@glows777/vela'
import { createFauxModel, fauxText, fauxToolCall } from '@glows777/vela/testing'

const cwd = mkdtempSync(join(tmpdir(), 'vela-example-'))
writeFileSync(join(cwd, 'notes.txt'), 'Ship the docs on Friday.\n')

const model = createFauxModel({
  responses: [
    fauxToolCall('read_file', { path: 'notes.txt' }),
    // A function step builds the reply from the request: here, from the tool result.
    (req) =>
      fauxText(`The note says: ${req.toolResults[0]?.output.split('\n')[0]}`),
  ],
})
const vela = createVela({ model, cwd })

try {
  const session = vela.session()
  let streaming = false
  session.subscribe((event) => {
    switch (event.type) {
      case 'agent_start':
        console.log(`[agent_start] ${event.input}`)
        break
      case 'turn_start':
        console.log(`[turn_start] turn ${event.turn}`)
        break
      case 'message_update':
        // The assistant message streams as updates; text_delta carries the new text
        if (event.assistantMessageEvent.type === 'text_delta') {
          process.stdout.write(event.assistantMessageEvent.delta)
          streaming = true
        }
        break
      case 'message_end':
        if (event.message.role === 'assistant')
          console.log(
            `${streaming ? '\n' : ''}[message_end] assistant, ${event.stopReason}`,
          )
        streaming = false
        break
      case 'tool_execution_start':
        console.log(
          `[tool_execution_start] ${event.toolName} ${JSON.stringify(event.args)}`,
        )
        break
      case 'tool_execution_end':
        console.log(
          `[tool_execution_end] ${event.toolName}: ${String(event.result).split('\n')[0]}`,
        )
        break
      case 'usage':
        console.log(
          `[usage] in=${event.usage.inputTokens} out=${event.usage.outputTokens}`,
        )
        break
      case 'turn_end':
        console.log(`[turn_end] ${event.toolResults.length} tool result(s)`)
        break
      case 'agent_end':
        console.log(`[agent_end] ${event.reason}`)
        break
      case 'agent_settled':
        console.log('[agent_settled]')
        break
    }
  })
  await session.prompt('What does notes.txt say?')
} finally {
  await vela.dispose()
  rmSync(cwd, { recursive: true, force: true })
}
