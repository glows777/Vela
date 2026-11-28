/**
 * Minimal SDK usage: one in-process runtime, one session, one prompt.
 *
 * The faux model from `@glows777/vela/testing` plays back a scripted reply, so this runs offline.
 * A real app passes `defaultModel: 'openai/<model-id>'` (reading providers from `~/.vela/config.json`)
 * or an AI SDK LanguageModel.
 *
 * Run: bun examples/sdk/01-minimal.ts
 */
import { createRuntime } from '@glows777/vela'
import { createFauxModel, fauxText } from '@glows777/vela/testing'

const defaultModel = createFauxModel({
  responses: [fauxText('Hello! I am a scripted faux model.')],
})

// ephemeral: true uses an in-memory SQLite DB and cleans up temp files on dispose().
const runtime = createRuntime({ ephemeral: true, defaultModel, mcp: false })

try {
  await runtime.ready()
  const session = await runtime.sessions.create({ name: 'minimal' })
  await runtime.prompt(session.id, { text: 'Say hello' })
  await runtime.waitForIdle(session.id)

  const page = await runtime.sessions.messages({ sessionId: session.id })
  const last = page.messages.at(-1)
  if (last?.role === 'assistant') {
    console.log(last.text)
  }
  console.log(`messages: ${page.messages.length}`)
} finally {
  await runtime.dispose()
}
