/**
 * Custom session storage: keep sessions wherever you like (a database, a KV store, ...).
 *
 * A SessionStorage has `load`, `append` and optionally `list`. A session is an append-only list of
 * entries (a header, then messages, compactions, setting changes; see docs/session-format.md), so a
 * table with one row per entry fits. Here a Map of JSON lines stands in for a database; a second Vela
 * on the same storage resumes the conversation.
 *
 * Run: bun examples/sdk/04-custom-storage.ts
 */
import {
  createVela,
  type SessionFileEntry,
  type SessionStorage,
  summarizeSession,
} from '@glows777/vela'
import { createFauxModel, fauxText } from '@glows777/vela/testing'

const rows = new Map<string, string[]>()

const storage: SessionStorage = {
  async load(id) {
    return rows.get(id)?.map((row) => JSON.parse(row) as SessionFileEntry)
  },
  async append(id, entries) {
    const list = rows.get(id) ?? []
    list.push(...entries.map((entry) => JSON.stringify(entry)))
    rows.set(id, list)
  },
  async list() {
    const summaries = [...rows.keys()].map(async (id) =>
      summarizeSession(id, (await this.load(id)) ?? []),
    )
    return (await Promise.all(summaries)).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    )
  },
}

// First process: talk, then shut down. Each message is appended as it enters the history.
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
