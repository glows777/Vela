/**
 * Persistent SQLite sessions: pass a shared `dataDir` so sessions persist in
 * `<dataDir>/vela.db` and resume across Vela restarts.
 *
 * Run: bun examples/sdk/04-custom-storage.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVela } from '@glows777/vela'
import { createFauxModel, fauxText } from '@glows777/vela/testing'

const dataDir = mkdtempSync(join(tmpdir(), 'vela-example-storage-'))

try {
  // First process: talk, then shut down. Messages are stored in <dataDir>/vela.db.
  const first = createVela({
    model: createFauxModel({
      responses: [fauxText('Noted: your name is Ada.')],
    }),
    dataDir,
  })
  const session = first.session('support-42')
  session.setName('Ada support chat')
  await session.prompt('My name is Ada.')
  console.log('saved sessions:', await first.listSessions())
  await first.dispose()

  // Second process: same dataDir, same id. resume() restores the history.
  const second = createVela({
    model: createFauxModel({
      responses: [
        (req) =>
          fauxText(
            req.prompt.some(
              (m) =>
                m.role === 'user' && JSON.stringify(m.content).includes('Ada'),
            )
              ? 'You are Ada.'
              : 'I do not know.',
          ),
      ],
    }),
    dataDir,
  })
  try {
    const resumed = second.session('support-42')
    console.log('resumed:', await resumed.resume(), `name=${resumed.name}`)
    await resumed.prompt('What is my name?')
    const last = resumed.messages.at(-1)
    if (last?.role === 'assistant' && Array.isArray(last.content))
      for (const part of last.content)
        if (part.type === 'text') console.log('answer:', part.text)
    console.log(`history: ${resumed.messages.length} messages`)
  } finally {
    await second.dispose()
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}
