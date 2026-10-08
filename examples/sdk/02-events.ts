/**
 * Subscribe to session events: streamed text, tool calls and results, usage and the end of the run.
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
      case 'text_delta':
        process.stdout.write(event.text)
        streaming = true
        break
      case 'tool_call':
        console.log(
          `[tool_call] ${event.toolName} ${JSON.stringify(event.input)}`,
        )
        break
      case 'tool_result':
        console.log(
          `[tool_result] ${event.toolName}: ${String(event.output).split('\n')[0]}`,
        )
        break
      case 'usage':
        // usage follows the streamed text of a model response
        if (streaming) process.stdout.write('\n')
        streaming = false
        console.log(
          `[usage] in=${event.usage.inputTokens} out=${event.usage.outputTokens}`,
        )
        break
      case 'turn_end':
        console.log(`[turn_end] needsToolCall=${event.needsToolCall}`)
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
