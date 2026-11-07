/**
 * Real SDK + Local HTTP/SSE drive; only the model is faux. Run via verify-vela:
 * $H exec $RUN local bun $REPO/.skills/verify-vela/scripts/local-journeys.ts
 * This uses the same script client as an app, not internal channel state.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { createVela, local } from '@glows777/vela'
import { createFauxModel, type FauxRequest } from '@glows777/vela/testing'
import { LocalClient, type LocalEvent } from '../../../examples/local-client.ts'

const token = 'offline-verification-only'
const reservation = createServer()
await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done))
const address = reservation.address()
if (!address || typeof address === 'string') throw new Error('No port')
await new Promise<void>((done, reject) =>
  reservation.close((error) => (error ? reject(error) : done())),
)
const port = address.port
const cwd = resolve('local-project')
mkdirSync(cwd, { recursive: true })
const dataDir = resolve('local-deployment')
const router = (request: FauxRequest) => {
  if (request.tools.includes('channel_start_topic')) {
    if (request.lastUserText.includes('Report status'))
      return { text: 'The task completed; its file is ready.' }
    return request.toolResults.length
      ? { text: 'Dispatched' }
      : {
          toolCalls: [
            {
              name: 'channel_start_topic',
              input: {
                title: 'Create a project file',
                brief: 'Write result.txt in the project directory',
              },
            },
          ],
        }
  }
  return request.toolResults.length
    ? { text: 'Created result.txt successfully' }
    : {
        reasoning: 'PRIVATE_REASONING_SENTINEL',
        toolCalls: [
          {
            name: 'write_file',
            input: {
              path: 'result.txt',
              content: 'local verification succeeded\n',
            },
          },
        ],
      }
}
const model = createFauxModel({ responses: Array(30).fill(router) })
const start = async () => {
  const vela = createVela({
    cwd: process.cwd(),
    dataDir,
    model,
    extensions: [local({ token, port })],
  })
  await vela.startChannels()
  return vela
}
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) throw new Error(name)
}
const until = async (check: () => Promise<boolean> | boolean) => {
  const end = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Local verification timeout')
    await new Promise((done) => setTimeout(done, 5))
  }
}
const client = new LocalClient(`http://127.0.0.1:${port}`, token)
let vela = await start()
const controller = new AbortController()
let reading: Promise<void> | undefined
try {
  const project = await client.request<{ id: string; sessionId: string }>(
    '/v1/projects',
    { cwd, name: 'Verify Local' },
  )
  const path = `/v1/projects/${project.id}/sessions`
  const stream = client.events(
    `/v1/events?projectId=${project.id}`,
    controller.signal,
  )
  const first = await stream.next()
  check('initial SSE reset', first.value?.event === 'reset')
  console.log(JSON.stringify(first.value))
  const events: LocalEvent[] = []
  reading = (async () => {
    try {
      for await (const event of stream) {
        events.push(event)
        console.log(JSON.stringify(event))
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error
    }
  })()
  const receipt = await client.request(
    `${path}/${project.sessionId}/messages`,
    { text: 'Create a project file', clientMessageId: 'verify-local-1' },
  )
  console.log(`Admission: ${JSON.stringify(receipt)}`)
  await until(() => events.some((event) => event.event === 'status'))
  check(
    'file written in project cwd',
    readFileSync(resolve(cwd, 'result.txt'), 'utf8') ===
      'local verification succeeded\n',
  )
  check(
    'thinking and tool arguments not broadcast',
    !JSON.stringify(events).includes('PRIVATE_REASONING_SENTINEL') &&
      !JSON.stringify(events).includes('local verification succeeded'),
  )
  const sessions = await client.request<{
    sessions: { sessionId: string; topic?: unknown }[]
  }>(path)
  const task = sessions.sessions.find((session) => session.topic)
  check('task appears in public directory', !!task)
  await until(() =>
    events.some((event) => {
      const envelope = event.data as {
        sessionId?: string
        data?: { state?: string }
      }
      return (
        event.event === 'session' &&
        envelope.sessionId === task!.sessionId &&
        envelope.data?.state === 'done'
      )
    }),
  )
  check('SSE publishes settled task state', true)
  for (const sessionId of [project.sessionId, task!.sessionId]) {
    const runEvents = (type: string) =>
      events.filter(
        (event) =>
          event.event === type &&
          (event.data as { sessionId?: string }).sessionId === sessionId,
      )
    await until(() => runEvents('run_finished').length === 1)
    const started = runEvents('run_started')
    const finished = runEvents('run_finished')
    const start = started[0]?.data as { runId?: string }
    const finish = finished[0]?.data as { runId?: string }
    check(
      `exact lifecycle for ${sessionId}`,
      started.length === 1 && !!start.runId && start.runId === finish.runId,
    )
  }
  const settled = await client.request<{
    sessions: { sessionId: string; state: string; runId?: string }[]
  }>(path)
  check(
    'settled task snapshot has no expired Stop target',
    settled.sessions.some(
      (session) =>
        session.sessionId === task!.sessionId &&
        session.state === 'done' &&
        session.runId === undefined,
    ),
  )

  const historyPath = `${path}/${task!.sessionId}/messages`
  const history = await client.request(historyPath)
  check(
    'task reply appears in visible history',
    JSON.stringify(history).includes('Created result.txt successfully'),
  )
  const callsBefore = model.calls.length
  controller.abort()
  await reading
  await client.request(`${path}/${project.sessionId}/messages`, {
    text: 'Report status',
  })
  await until(async () =>
    JSON.stringify(
      await client.request(`${path}/${project.sessionId}/messages`),
    ).includes('The task completed'),
  )
  check(
    'disconnected client does not block delivery',
    model.calls.length === callsBefore + 1,
  )
  check(
    'hub sees saved completion status',
    JSON.stringify(model.calls.at(-1)!.prompt).includes(
      'Created result.txt successfully',
    ),
  )
  await vela.dispose()
  vela = await start()
  const reopened = await client.request<{ id: string }>('/v1/projects', { cwd })
  check('project ID survives restart', reopened.id === project.id)
  check(
    'visible history survives restart',
    JSON.stringify(await client.request(historyPath)) ===
      JSON.stringify(history),
  )
  const reconnect = client.events(`/v1/events?projectId=${project.id}`)
  check(
    'restart sends reset, not replay',
    (await reconnect.next()).value?.event === 'reset',
  )
  await reconnect.return(undefined)
  console.log(
    'Local journey complete. Provider quality remains unverified: the model was faux.',
  )
} finally {
  controller.abort()
  await reading
  await vela.dispose()
}
