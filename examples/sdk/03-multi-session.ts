/**
 * Several sessions in one Vela, running at the same time.
 *
 * Sessions share tools, extensions and the model, but each has its own history, queue,
 * usage, role and run lock. This is how a channel (for example Feishu) serves many users:
 * one session per conversation and sender.
 *
 * Run: bun examples/sdk/03-multi-session.ts
 */
import { createVela } from '@glows777/vela'
import { createFauxModel, fauxText } from '@glows777/vela/testing'

// One reply per request, generated from the request; small chunks with a delay make the streams interleave.
const reply = (req: { lastUserText: string }) =>
  fauxText(`You said "${req.lastUserText}"`)
const model = createFauxModel({
  responses: [reply, reply, reply],
  chunkSize: 4,
  chunkDelayMs: 5,
})
const vela = createVela({ model })

try {
  // vela.subscribe() receives events from every session, with the session id.
  vela.subscribe((event, sessionId) => {
    if (event.type === 'agent_end')
      console.log(`[${sessionId}] agent_end: ${event.reason}`)
  })

  const alice = vela.session('alice')
  // Per-session options apply when the session is first opened.
  const bob = vela.session('bob', { role: 'guest' })

  await Promise.all([alice.prompt('Hi from Alice'), bob.prompt('Hi from Bob')])
  await alice.prompt('Alice again')

  for (const session of vela.sessions()) {
    const users = session.messages.filter((m) => m.role === 'user').length
    console.log(
      `${session.id}: role=${session.role}, ${session.messages.length} messages, ${users} from the user`,
    )
  }
} finally {
  await vela.dispose()
}
