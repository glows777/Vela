/**
 * Minimal SDK usage: one Vela, one session, one prompt.
 *
 * The faux model from `@glows777/vela/testing` plays back a scripted reply, so this runs offline.
 * A real app passes `model: 'openai/<model-id>'` (with `providers` from loadConfig()) or an AI SDK LanguageModel.
 *
 * Run: bun examples/sdk/01-minimal.ts
 */
import { createVela } from '@glows777/vela'
import { createFauxModel, fauxText } from '@glows777/vela/testing'

const model = createFauxModel({
  responses: [fauxText('Hello! I am a scripted faux model.')],
})

// No dataDir: nothing persists. The session lives in memory and dispose() deletes the temp files.
const vela = createVela({ model })

try {
  const session = vela.session()
  // Resolves when the run is finished (including tool calls and queued messages).
  await session.prompt('Say hello')

  const last = session.messages.at(-1)
  if (last?.role === 'assistant' && Array.isArray(last.content)) {
    for (const part of last.content)
      if (part.type === 'text') console.log(part.text)
  }
  console.log(`messages: ${session.messages.length}`)
} finally {
  await vela.dispose()
}
