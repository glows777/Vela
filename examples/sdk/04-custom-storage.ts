/**
 * Persistent SQLite sessions: pass a shared `agentDir` so sessions persist in
 * `<agentDir>/vela.db` and resume across Runtime restarts.
 *
 * Run: bun examples/sdk/04-custom-storage.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '@glows777/vela'
import { createFauxModel, fauxText } from '@glows777/vela/testing'

const agentDir = mkdtempSync(join(tmpdir(), 'vela-example-storage-'))

try {
  // First process: talk, then shut down. Messages are stored in <agentDir>/vela.db.
  const first = createRuntime({
    agentDir,
    defaultModel: createFauxModel({
      responses: [fauxText('Noted: your name is Ada.')],
    }),
    mcp: false,
  })
  await first.ready()
  await first.sessions.create({ id: 'support-42', name: 'Ada support chat' })
  await first.prompt('support-42', { text: 'My name is Ada.' })
  await first.waitForIdle('support-42')
  console.log('saved sessions:', await first.sessions.listSummaries())
  await first.dispose()

  // Second process: same agentDir, same session id. Prompting continues the saved transcript.
  const second = createRuntime({
    agentDir,
    defaultModel: createFauxModel({
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
    mcp: false,
  })
  try {
    await second.ready()
    const restored = await second.sessions.get('support-42')
    console.log('resumed:', restored !== undefined, `name=${restored?.name}`)
    await second.prompt('support-42', { text: 'What is my name?' })
    await second.waitForIdle('support-42')
    const page = await second.sessions.messages({ sessionId: 'support-42' })
    const last = page.messages.at(-1)
    if (last?.role === 'assistant') {
      console.log('answer:', last.text)
    }
    console.log(`history: ${page.messages.length} messages`)
  } finally {
    await second.dispose()
  }
} finally {
  rmSync(agentDir, { recursive: true, force: true })
}
