import type { VelaExtension } from '../types.ts'
import { BACKGROUND_BUSY } from './host.ts'
import { BackgroundJobs } from './jobs.ts'
import { createBackgroundTools } from './tool.ts'

export interface BackgroundOptions {
  /** Resolved shell, as the bash tool receives it; default bash on PATH, or bash.exe on Windows */
  shellPath?: string
}

/**
 * Long-running commands whose result arrives on its own: `background_start` returns an id at once,
 * `background_output` reads the tail, `background_stop` ends the command. Core's `bash` stays
 * synchronous. Jobs belong to their session: Stop, close and process restart end them, and nothing
 * is persisted. In a channel session the exit enters the gateway's queue, so it arrives as an
 * ordinary reply in the session's topic; elsewhere it is a custom message that starts a turn.
 */
export function background(options: BackgroundOptions = {}): VelaExtension {
  return function background(vela) {
    const shell = () =>
      options.shellPath ?? (process.platform === 'win32' ? 'bash.exe' : 'bash')
    const sessions = new Map<string, BackgroundJobs>()
    const jobs = (context: { sessionId?: string } | undefined) => {
      const id = context?.sessionId
      // Tools are shared by every session, so an id comes from the call itself.
      const current = id === undefined ? undefined : sessions.get(id)
      if (!current)
        throw new Error('Background commands require an open session')
      return current
    }
    for (const tool of createBackgroundTools(jobs)) vela.registerTool(tool)
    vela.on('session_start', (_event, { session }) => {
      const current = new BackgroundJobs(session, shell, vela.logger)
      sessions.set(session.id, current)
      // Channel idle cleanup reads this so a long command is not killed by a quiet conversation.
      ;(session as unknown as Record<symbol, () => boolean>)[BACKGROUND_BUSY] =
        () => current.running > 0
    })
    // Stop aborts the run; every job in the session goes with it, so none can be orphaned.
    vela.on('agent_end', (event, { session }) => {
      if (event.reason !== 'aborted') return
      void sessions.get(session.id)?.stopAll()
    })
    vela.on('session_shutdown', async (_event, { session }) => {
      const current = sessions.get(session.id)
      sessions.delete(session.id)
      await current?.stopAll()
    })
  }
}
