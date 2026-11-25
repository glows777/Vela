import { routineLocalTime } from '../shared/routine-time.ts'
import type { SessionStatusInfo } from './domain.ts'
import type { TimerRecord } from './timers.ts'

export type ControlShortcut = 'stop' | 'restart' | 'status' | 'timers'

/**
 * Parses direct Runtime control shortcuts (`!stop`, `!restart`, `!status`, `!timers`).
 * Legacy `!routines` is intentionally not supported in v0.9.
 */
export function parseControlShortcut(
  text: string,
): ControlShortcut | undefined {
  const trimmed = text.trim()
  switch (trimmed) {
    case '!stop':
      return 'stop'
    case '!restart':
      return 'restart'
    case '!status':
      return 'status'
    case '!timers':
      return 'timers'
    default:
      return undefined
  }
}

export interface ShortcutTarget {
  stopSession(sessionId: string): Promise<boolean>
  restartSession(sessionId: string): Promise<void>
  sessionStatus(sessionId: string): SessionStatusInfo
  listTimers(filter: { projectId?: string; sessionId?: string }): TimerRecord[]
}

export async function executeControlShortcut(
  runtime: ShortcutTarget,
  input: {
    command: ControlShortcut
    sessionId: string
    projectId?: string | null
  },
): Promise<{ text: string; stopped?: boolean }> {
  switch (input.command) {
    case 'stop': {
      const stopped = await runtime.stopSession(input.sessionId)
      return {
        stopped,
        text: stopped ? 'Stopped active run.' : 'No run is currently active.',
      }
    }
    case 'restart': {
      await runtime.restartSession(input.sessionId)
      return { text: 'Restarted with a fresh session.' }
    }
    case 'status': {
      const info = runtime.sessionStatus(input.sessionId)
      const lines = [
        `Session: ${info.session.id} (${info.session.state})`,
        `Model: ${info.session.model ?? 'default'} (${info.session.thinkingLevel ?? 'default'})`,
        `Tokens: in=${info.usage.inputTokens}, out=${info.usage.outputTokens}, cache_read=${info.usage.cacheReadTokens}`,
        `Pending approvals: ${info.pendingApprovals}, running jobs: ${info.runningJobs}`,
      ]
      return { text: lines.join('\n') }
    }
    case 'timers': {
      const timers = runtime.listTimers(
        input.projectId
          ? { projectId: input.projectId }
          : { sessionId: input.sessionId },
      )
      if (!timers.length) return { text: 'No timers configured.' }
      const lines = timers.map((timer) => {
        const next = timer.nextFireAt
          ? routineLocalTime(Date.parse(timer.nextFireAt), timer.timezone)
          : 'inactive'
        return `- [${timer.kind}] ${timer.id}: "${timer.message}" (next: ${next}, enabled=${timer.enabled})`
      })
      return { text: lines.join('\n') }
    }
  }
}
