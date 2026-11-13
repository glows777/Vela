import type { ServerResponse } from 'node:http'
import { type LocalEvents, localEnvelope } from './local-events.ts'
import type { LocalEvent } from './local-protocol.ts'

/** SSE owns only its connections; reconnect reloads durable snapshots, without replay. */
export class LocalSse {
  private readonly clients = new Map<ServerResponse, () => void>()

  constructor(private events: LocalEvents) {}

  connect(res: ServerResponse, projectId?: string): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-store',
      'x-accel-buffering': 'no',
    })
    const heartbeat = setInterval(() => {
      if (!res.write(': heartbeat\n\n')) res.destroy()
    }, 15000)
    heartbeat.unref?.()
    const unsubscribe = this.events.subscribe(
      (event) => this.write(res, event),
      { projectId },
    )
    const cleanup = () => {
      clearInterval(heartbeat)
      unsubscribe()
      this.clients.delete(res)
    }
    this.clients.set(res, cleanup)
    res.once('close', cleanup)
    this.write(
      res,
      localEnvelope(
        {
          type: 'reset',
          data: { reason: 'connected', reload: ['sessions', 'messages'] },
        },
        { projectId },
      ),
    )
  }

  stop(): void {
    for (const [res, cleanup] of this.clients) {
      cleanup()
      res.destroy()
    }
  }

  private write(res: ServerResponse, event: LocalEvent): void {
    // Never queue behind a slow app or block model delivery. Reconnect reloads history.
    if (
      !res.write(
        `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
    )
      res.destroy()
  }
}
