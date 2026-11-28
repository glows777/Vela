/**
 * Several sessions in one Runtime, running at the same time.
 *
 * Sessions share drivers, extensions, and models, while each keeps its own transcript,
 * inbox queue, usage, and active run lock.
 *
 * Run: bun examples/sdk/03-multi-session.ts
 */
import { createRuntime } from '@glows777/vela'
import { createFauxModel, fauxText } from '@glows777/vela/testing'

const reply = (req: { lastUserText: string }) =>
  fauxText(`You said "${req.lastUserText}"`)
const defaultModel = createFauxModel({
  responses: [reply, reply, reply],
  chunkSize: 4,
  chunkDelayMs: 5,
})
const runtime = createRuntime({ ephemeral: true, defaultModel, mcp: false })

try {
  await runtime.ready()
  const off = runtime.events.subscribe((event) => {
    if (event.type === 'run_finished') {
      console.log(`[${event.sessionId}] run_finished: ${event.status}`)
    }
  })

  try {
    const alice = await runtime.sessions.create({ id: 'alice', name: 'Alice' })
    const bob = await runtime.sessions.create({ id: 'bob', name: 'Bob' })
    // Per-session tool overrides apply on that session's runs.
    await runtime.sessions.configure(bob.id, { tools: ['-bash'] })

    await Promise.all([
      runtime.prompt(alice.id, { text: 'Hi from Alice' }),
      runtime.prompt(bob.id, { text: 'Hi from Bob' }),
    ])
    await Promise.all([
      runtime.waitForIdle(alice.id),
      runtime.waitForIdle(bob.id),
    ])

    await runtime.prompt(alice.id, { text: 'Alice again' })
    await runtime.waitForIdle(alice.id)

    for (const session of await runtime.sessions.list()) {
      const page = await runtime.sessions.messages({ sessionId: session.id })
      const users = page.messages.filter((m) => m.role === 'user').length
      console.log(
        `${session.id}: ${page.messages.length} messages, ${users} from the user`,
      )
    }
  } finally {
    off()
  }
} finally {
  await runtime.dispose()
}
