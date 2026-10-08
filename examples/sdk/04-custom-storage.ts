/**
 * Custom session storage: keep session checkpoints wherever you like (a database, a KV store, ...).
 *
 * A SessionStorage has `load`, `save` and optionally `list`. Every save is a full checkpoint
 * (see docs/session-format.md). Here a Map of JSON strings stands in for a database; a second
 * Vela on the same storage resumes the conversation.
 *
 * Run: bun examples/sdk/04-custom-storage.ts
 */
import {
  createVela,
  type SessionCheckpoint,
  type SessionStorage,
  type SessionSummary,
} from '@glows777/vela'
import { createFauxModel, fauxText } from '@glows777/vela/testing'

const rows = new Map<string, string>()

const storage: SessionStorage = {
  async load(id) {
    const row = rows.get(id)
    return row === undefined
      ? undefined
      : (JSON.parse(row) as SessionCheckpoint)
  },
  async save(id, checkpoint) {
    rows.set(id, JSON.stringify(checkpoint))
  },
  async list() {
    const summaries: SessionSummary[] = []
    for (const [id, row] of rows) {
      const checkpoint = JSON.parse(row) as SessionCheckpoint
      const first = checkpoint.messages.find((m) => m.message.role === 'user')
      summaries.push({
        id,
        name: checkpoint.name,
        updatedAt: checkpoint.timestamp,
        messageCount: checkpoint.messages.length,
        firstMessage:
          typeof first?.message.content === 'string'
            ? first.message.content
            : '',
      })
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  },
}

// First process: talk, then shut down. prompt() saves the session when it finishes.
const first = createVela({
  model: createFauxModel({ responses: [fauxText('Noted: your name is Ada.')] }),
  sessionStorage: storage,
})
const session = first.session('support-42')
session.setName('Ada support chat')
await session.prompt('My name is Ada.')
console.log('saved sessions:', await first.listSessions())
await first.dispose()

// Second process: same storage, same id. resume() restores the history.
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
  sessionStorage: storage,
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
