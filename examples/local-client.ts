/**
 * Minimal authenticated Local-channel client (not RPC): connect to an existing `vela serve`.
 *   VELA_LOCAL_TOKEN=... bun examples/local-client.ts /absolute/project/path 'Hello'
 * The token is sent only in Authorization, never in a URL or printed to the console.
 * Set VELA_LOCAL_URL if the server uses a port other than 8788.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface LocalEvent {
  event: string
  data: unknown
}

export class LocalClient {
  constructor(
    readonly url: string,
    private readonly token: string,
  ) {}

  async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.url), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok)
      throw new Error(`Local HTTP ${response.status}: ${await response.text()}`)
    return (await response.json()) as T
  }

  /** fetch supports Bearer auth, unlike the browser's native EventSource constructor. */
  async *events(
    path: string,
    signal?: AbortSignal,
  ): AsyncGenerator<LocalEvent> {
    const response = await fetch(new URL(path, this.url), {
      headers: { Authorization: `Bearer ${this.token}` },
      signal,
    })
    if (!response.ok || !response.body)
      throw new Error(`Local SSE HTTP ${response.status}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          let event = 'message'
          const data: string[] = []
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
          }
          if (data.length) yield { event, data: JSON.parse(data.join('\n')) }
          boundary = buffer.indexOf('\n\n')
        }
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}

async function main() {
  const token = process.env.VELA_LOCAL_TOKEN
  if (!token) throw new Error('Set VELA_LOCAL_TOKEN to match your Local server')
  const client = new LocalClient(
    process.env.VELA_LOCAL_URL ?? 'http://127.0.0.1:8788',
    token,
  )
  const cwd = resolve(process.argv[2] ?? '.')
  const project = await client.request<{ id: string; sessionId: string }>(
    '/v1/projects',
    { cwd },
  )
  const controller = new AbortController()
  const events = client.events(
    `/v1/events?projectId=${project.id}`,
    controller.signal,
  )
  try {
    console.log(JSON.stringify((await events.next()).value))
    // Every connection starts with reset: replace local state from durable snapshots.
    const sessions = await client.request<{
      sessions: { sessionId: string }[]
    }>(`/v1/projects/${project.id}/sessions`)
    console.log(JSON.stringify(sessions))
    for (const session of sessions.sessions) {
      let after: string | undefined
      do {
        const history = await client.request<{
          messages: unknown[]
          nextCursor?: string
        }>(
          `/v1/projects/${project.id}/sessions/${session.sessionId}/messages?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`,
        )
        console.log(
          JSON.stringify({ sessionId: session.sessionId, ...history }),
        )
        after = history.nextCursor
      } while (after)
    }
    const accepted = await client.request(
      `/v1/projects/${project.id}/sessions/${project.sessionId}/messages`,
      { text: process.argv.slice(3).join(' ') || 'Hello' },
    )
    console.log(JSON.stringify(accepted))
    for await (const event of events) {
      console.log(JSON.stringify(event))
      if (event.event === 'run_finished') break
    }
  } finally {
    controller.abort()
    await events.return(undefined)
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
