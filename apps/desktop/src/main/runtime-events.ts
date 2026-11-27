import type { RuntimeEvent } from '@glows777/vela'
import type { Event, Message, Session } from '../shared/bridge.ts'
import { formatFailedTaskReply } from './runtime-history.ts'

export function mapLocalRuntimeEvent(
  event: RuntimeEvent,
  chatId: string | null,
  desktopSession: Session,
  desktopMessage?: Message,
): Event[] {
  const base = {
    version: 1 as const,
    id: `evt-${event.seq}`,
    time: event.timestamp,
    ...(chatId ? { projectId: chatId } : {}),
    sessionId: event.sessionId,
    ...('runId' in event && event.runId ? { runId: event.runId } : {}),
  }
  switch (event.type) {
    case 'run_started':
      return [
        {
          type: 'session',
          channel: 'local',
          value: {
            session: desktopSession,
            run: { type: 'started', runId: event.runId },
          },
        },
        {
          type: 'local',
          channel: 'local',
          value: { ...base, type: 'session', data: desktopSession },
        },
        {
          type: 'local',
          channel: 'local',
          value: { ...base, type: 'run_started', data: {} },
        },
      ]
    case 'message_committed': {
      const events: Event[] = []
      if (desktopMessage) {
        events.push({
          type: 'local',
          channel: 'local',
          value: { ...base, type: 'message', data: desktopMessage },
        })
      }
      events.push({
        type: 'local',
        channel: 'local',
        value: { ...base, type: 'session', data: desktopSession },
      })
      return events
    }
    case 'tool_started':
      return [
        {
          type: 'local',
          channel: 'local',
          value: {
            ...base,
            type: 'progress',
            data: { stage: 'tool', tool: event.toolName, state: 'started' },
          },
        },
      ]
    case 'tool_finished':
      return [
        {
          type: 'local',
          channel: 'local',
          value: {
            ...base,
            type: 'progress',
            data: {
              stage: 'tool',
              tool: event.toolName,
              state: event.isError ? 'failed' : 'finished',
            },
          },
        },
      ]
    case 'auto_retry_start':
      return [
        {
          type: 'local',
          channel: 'local',
          value: {
            ...base,
            type: 'progress',
            data: { stage: 'retry', state: 'started' },
          },
        },
      ]
    case 'auto_retry_end':
      return [
        {
          type: 'local',
          channel: 'local',
          value: {
            ...base,
            type: 'progress',
            data: {
              stage: 'retry',
              state: event.success ? 'finished' : 'failed',
            },
          },
        },
      ]
    case 'compaction_started':
      return [
        {
          type: 'local',
          channel: 'local',
          value: {
            ...base,
            type: 'progress',
            data: { stage: 'compaction', state: 'started' },
          },
        },
      ]
    case 'compaction_finished':
      return [
        {
          type: 'local',
          channel: 'local',
          value: {
            ...base,
            type: 'progress',
            data: { stage: 'compaction', state: 'finished' },
          },
        },
      ]
    case 'compaction_failed':
      return [
        {
          type: 'local',
          channel: 'local',
          value: {
            ...base,
            type: 'progress',
            data: { stage: 'compaction', state: 'failed' },
          },
        },
      ]
    case 'run_finished': {
      const outcome =
        event.status === 'failed' || event.status === 'interrupted'
          ? 'failed'
          : event.status === 'stopped'
            ? 'stopped'
            : event.silent
              ? 'silent'
              : 'done'
      const events: Event[] = []
      if (outcome === 'failed' && event.error) {
        events.push(
          {
            type: 'local',
            channel: 'local',
            value: {
              ...base,
              type: 'error',
              data: {
                code: event.errorKind ?? 'failed',
                message: event.error,
              },
            },
          },
          {
            type: 'local',
            channel: 'local',
            value: {
              ...base,
              id: `evt-${event.seq}-failed-msg`,
              type: 'message',
              data: {
                id: `failed-${event.runId}`,
                sessionId: event.sessionId,
                role: 'assistant',
                text: formatFailedTaskReply(event.error, event.errorHint),
                createdAt: event.timestamp,
              },
            },
          },
        )
      }
      events.push(
        {
          type: 'session',
          channel: 'local',
          value: {
            session: desktopSession,
            run: { type: 'finished', runId: event.runId, outcome },
          },
        },
        {
          type: 'local',
          channel: 'local',
          value: { ...base, type: 'session', data: desktopSession },
        },
        {
          type: 'local',
          channel: 'local',
          value: { ...base, type: 'run_finished', data: { outcome } },
        },
      )
      return events
    }
    default:
      return []
  }
}
