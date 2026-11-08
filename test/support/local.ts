import { createServer } from 'node:net'
import { LocalClient, type LocalEvent } from '../../examples/local-client.ts'

export { LocalClient }
export const LOCAL_TOKEN = 'fixture-local-token-not-for-production'
export interface Project {
  id: string
  cwd: string
  name: string
  sessionId: string
  channel: 'local'
}
export interface VisibleMessage {
  id: string
  sessionId: string
  role: string
  text: string
  createdAt: string
  clientMessageId?: string
}
export interface Snapshot {
  sessionId: string
  state: string
  topic?: { rootId: string; threadId: string }
  runId?: string
}
export function sessionPath(project: Project, sessionId = project.sessionId) {
  return `/v1/projects/${project.id}/sessions/${sessionId}`
}
export async function freeLocalPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No local port')
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return address.port
}
export async function until(
  check: () => boolean | Promise<boolean>,
  label = 'Local condition',
) {
  const deadline = Date.now() + 3000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await Bun.sleep(1)
  }
}
export async function watchLocal(client: LocalClient, projectId?: string) {
  const controller = new AbortController()
  const events: LocalEvent[] = []
  const stream = client.events(
    `/v1/events${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    controller.signal,
  )
  const first = await stream.next()
  if (first.value) events.push(first.value)
  const reading = (async () => {
    try {
      for await (const event of stream) events.push(event)
    } catch (error) {
      if (!controller.signal.aborted) throw error
    }
  })()
  return {
    events,
    async close() {
      controller.abort()
      await reading
    },
  }
}
