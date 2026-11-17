import { setSessionBackground } from '../../session/routing.ts'
import type { VelaExtension } from '../types.ts'
import { BackgroundJobs } from './jobs.ts'
import { createBackgroundTools } from './tool.ts'

/**
 * Background commands whose result arrives on its own. `bash` starts one with `run_in_background`
 * and returns at once with its id and output file; `background_output` reads the tail and
 * `background_stop` ends the command. The jobs belong to their session: Stop, close and process
 * restart end them, and nothing is persisted. In a channel session the exit enters the gateway's
 * queue, so it arrives as an ordinary reply in the session's topic; elsewhere it is a custom message
 * that starts a turn.
 */
export function background(): VelaExtension {
  return function background(vela) {
    const sessions = new Map<string, BackgroundJobs>()
    for (const tool of createBackgroundTools()) vela.registerTool(tool)
    vela.on('session_start', (_event, { session }) => {
      const jobs = new BackgroundJobs(session, vela.logger)
      sessions.set(session.id, jobs)
      setSessionBackground(session, jobs)
    })
    // Stop aborts the run; every job in the session goes with it, so none can be orphaned.
    vela.on('agent_end', (event, { session }) => {
      if (event.reason !== 'aborted') return
      void sessions.get(session.id)?.stopAll()
    })
    vela.on('session_shutdown', async (_event, { session }) => {
      const current = sessions.get(session.id)
      sessions.delete(session.id)
      setSessionBackground(session, undefined)
      await current?.stopAll()
    })
  }
}
