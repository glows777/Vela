/**
 * Subscribe to Runtime durable events and live stream deltas: streamed text, tool calls,
 * committed messages, and the end of the run.
 *
 * The faux model first asks for the `read` tool, then answers. The tool really runs
 * against a temporary working directory created here.
 *
 * Run: bun examples/sdk/02-events.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '@glows777/vela'
import { createFauxModel, fauxText, fauxToolCall } from '@glows777/vela/testing'

const cwd = mkdtempSync(join(tmpdir(), 'vela-example-'))
writeFileSync(join(cwd, 'notes.txt'), 'Ship the docs on Friday.\n')

const defaultModel = createFauxModel({
  responses: [
    fauxToolCall('read', { path: 'notes.txt' }),
    (req) =>
      fauxText(`The note says: ${req.toolResults[0]?.output.split('\n')[0]}`),
  ],
})
const runtime = createRuntime({
  ephemeral: true,
  defaultModel,
  mcp: false,
  trustOverride: () => true,
})

try {
  await runtime.ready()
  const project = await runtime.projects.create({
    name: 'EventsDemo',
    cwd,
    hubSessionId: true,
  })
  const sessionId = project.hubSessionId!

  let streaming = false
  const offDeltas = runtime.events.subscribeDeltas((delta) => {
    if (delta.sessionId !== sessionId) return
    if (delta.type === 'text_delta') {
      process.stdout.write(delta.delta)
      streaming = true
    }
  })
  const offEvents = runtime.events.subscribe((event) => {
    if (event.sessionId !== sessionId) return
    switch (event.type) {
      case 'run_started':
        console.log(`[run_started] trigger=${event.trigger}`)
        break
      case 'tool_started':
        console.log(
          `[tool_started] ${event.toolName} ${JSON.stringify(event.input)}`,
        )
        break
      case 'tool_finished':
        console.log(`[tool_finished] ${event.toolName} error=${event.isError}`)
        break
      case 'message_committed':
        if (event.message.role === 'assistant') {
          console.log(`${streaming ? '\n' : ''}[message_committed] assistant`)
          streaming = false
        }
        break
      case 'run_finished':
        console.log(`[run_finished] ${event.status}`)
        break
    }
  })

  try {
    await runtime.prompt(sessionId, { text: 'What does notes.txt say?' })
    await runtime.waitForIdle(sessionId)
  } finally {
    offDeltas()
    offEvents()
  }
} finally {
  await runtime.dispose()
  rmSync(cwd, { recursive: true, force: true })
}
