import { randomUUID } from 'node:crypto'
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

/** Transport-neutral, future-only event delivery. Observers never block channel work. */
export class LocalEvents {
  private readonly listeners = new Set<{
    listener: (event: LocalEvent) => void
    projectId?: string
  }>()

  subscribe(
    listener: (event: LocalEvent) => void,
    options?: { projectId?: string },
  ): () => void {
    const entry = { listener, projectId: options?.projectId }
    this.listeners.add(entry)
    return () => {
      this.listeners.delete(entry)
    }
  }

  publish(
    event: LocalEventData,
    address: { projectId: string; sessionId?: string; runId?: string },
  ): void {
    const envelope = localEnvelope(event, address)
    for (const entry of this.listeners) {
      if (
        entry.projectId !== undefined &&
        entry.projectId !== address.projectId
      )
        continue
      try {
        // Every observer owns its snapshot. A throwing or async observer cannot affect another.
        void Promise.resolve(entry.listener(structuredClone(envelope))).catch(
          () => {},
        )
      } catch {
        /* Observer failures do not affect channel delivery. */
      }
    }
  }

  stop(): void {
    this.listeners.clear()
  }
}

export function localEnvelope(
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
