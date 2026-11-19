import { errorMessage } from '../../logger.ts'
import type { BackgroundCommands } from '../../tools/background.ts'
import type { ExtensionContext, VelaExtension } from '../types.ts'
import { BackgroundJobs } from './jobs.ts'
import { tasks } from './tasks.ts'
import { createBackgroundTools } from './tool.ts'

export interface BackgroundOptions {
  /**
   * Shell for a background command in a local session; default: the session's execution
   * environment chooses (bash on PATH, or bash.exe on Windows). An environment that is not local
   * runs the command itself and chooses its own shell.
   */
  shellPath?: string
}

/**
 * Long-running commands whose result arrives on its own: `bash` with `run_in_background` returns an
 * id at once, `background_output` reads the tail, `background_stop` ends the command. The extension
 * installs the session's job table, which `bash` reaches through `ToolContext`, so one shell tool
 * covers both foreground and background work and no second id, stop or delivery implementation
 * exists. A running call can also be moved to the background mid-run, and it is the same kind of job
 * afterwards. Jobs belong to their session, not to the run that started them: close and process
 * restart end them, an interrupted run does not. Nothing about execution is persisted, though a host
 * may persist jobs whose results are still owed. In a channel session the exit enters the gateway's
 * queue, so it arrives as an ordinary reply in the session's topic; elsewhere it is a custom message
 * that starts a turn.
 */
export function background(options: BackgroundOptions = {}): VelaExtension {
  return function background(vela) {
    const table = (current: BackgroundCommands | undefined) => {
      if (!current)
        throw new Error('Background commands require an open session')
      return current
    }
    // Tools are shared by every session, so the capability comes from the call itself.
    const commands = (
      context: { background?: BackgroundCommands } | undefined,
    ) => table(context?.background)
    for (const tool of createBackgroundTools(commands)) vela.registerTool(tool)
    const tasksCommand = {
      description:
        'List this session’s background tasks; /tasks stop <id> ends one',
      handler: async (args: string, ctx: ExtensionContext) => {
        try {
          // `session_start` installs the job table before any command runs.
          ctx.ui.notify(
            await tasks(args, table(ctx.session.registry.background)),
          )
        } catch (error) {
          ctx.ui.notify(errorMessage(error), 'error')
        }
      },
    }
    vela.registerCommand('tasks', tasksCommand)
    vela.registerCommand('bashes', tasksCommand)
    vela.on('session_start', (_event, { session }) => {
      session.registry.background = new BackgroundJobs(
        session,
        vela.logger,
        options.shellPath,
      )
    })
    vela.on('session_shutdown', async (_event, { session }) => {
      const jobs = session.registry.background
      session.registry.background = undefined
      await jobs?.stopAll()
    })
  }
}
