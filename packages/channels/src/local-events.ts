import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { VelaEvent } from '@glows777/vela-core/extension-api'
import type {
  LocalEvent,
  LocalEventData,
  LocalProgress,
} from './local-protocol.ts'

/** Deliberately never spread a core event: arguments, reasoning, results and provider errors stay private. */
export function localProgress(event: VelaEvent): LocalProgress | undefined {
  if (
    event.type === 'tool_execution_start' ||
    event.type === 'tool_execution_end'
  )
    return {
      stage: 'tool',
      // biome-ignore lint/suspicious/noControlCharactersInRegex: remove terminal control characters from display names
      tool: event.toolName.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80),
      state:
        event.type === 'tool_execution_start'
          ? 'started'
          : event.isError
            ? 'failed'
            : 'finished',
    }
  if (event.type === 'auto_retry_start') return { stage: 'retry' }
  if (event.type === 'compaction_start' || event.type === 'compaction_end')
    return {
      stage: 'compaction',
      state: event.type === 'compaction_start' ? 'started' : 'finished',
    }
}

/** No replay promise: every connection starts with reset and clients reload durable snapshots. */
export class LocalEvents {
  private readonly clients = new Map<
    ServerResponse,
    { projectId?: string; heartbeat: ReturnType<typeof setInterval> }
  >()

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
    this.clients.set(res, { projectId, heartbeat })
    res.once('close', () => {
      clearInterval(heartbeat)
      this.clients.delete(res)
    })
    this.write(
      res,
      this.envelope(
        {
          type: 'reset',
          data: { reason: 'connected', reload: ['sessions', 'messages'] },
        },
        { projectId },
      ),
    )
  }

  publish(
    event: LocalEventData,
    address: { projectId: string; sessionId?: string; runId?: string },
  ): void {
    const envelope = this.envelope(event, address)
    for (const [res, client] of this.clients)
      if (!client.projectId || client.projectId === address.projectId)
        this.write(res, envelope)
  }

  stop(): void {
    for (const [res, client] of this.clients) {
      clearInterval(client.heartbeat)
      res.destroy()
    }
    this.clients.clear()
  }

  private envelope(
    event: LocalEventData,
    address: { projectId?: string; sessionId?: string; runId?: string },
  ): LocalEvent {
    return {
      ...event,
      ...address,
      version: 1,
      id: randomUUID(),
      time: new Date().toISOString(),
    }
  }

  private write(res: ServerResponse, event: LocalEvent): void {
    // Never queue behind a slow app or block model delivery. The next connection reloads history.
    if (
      !res.write(
        `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
    )
      res.destroy()
  }
}
