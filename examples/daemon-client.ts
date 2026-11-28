/**
 * Connect to the running `vela daemon` over `<agentDir>/vela.sock` (or Windows named pipe).
 *
 * Start the daemon in another terminal first: `vela daemon start` (with a configured model,
 * or `VELA_MODEL=mock vela daemon run`).
 *
 * Run: bun examples/daemon-client.ts
 */
import { connectRuntime, getDaemonStatus } from '@glows777/vela'

const status = await getDaemonStatus()
if (!status.running) {
  console.error(
    'No running vela daemon found. Start one first with: vela daemon start',
  )
  process.exit(1)
}

const runtime = await connectRuntime({ agentDir: status.agentDir })
try {
  const session = await runtime.sessions.create({ name: 'daemon-client-demo' })
  const unsubscribe = runtime.events.subscribe((event) => {
    if (event.sessionId !== session.id) return
    if (event.type === 'run_finished') {
      console.log(`[run_finished] status=${event.status}`)
    }
  })
  const unsubscribeDeltas = runtime.events.subscribeDeltas((delta) => {
    if (delta.sessionId === session.id && delta.type === 'text_delta') {
      process.stdout.write(delta.delta)
    }
  })

  try {
    await runtime.prompt(session.id, {
      text: 'Reply with a one-sentence hello from the daemon.',
      source: 'user',
    })
    await runtime.waitForIdle(session.id)
    process.stdout.write('\n')
  } finally {
    unsubscribeDeltas()
    unsubscribe()
  }
} finally {
  await runtime.dispose()
}
