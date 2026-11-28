import type { RuntimeSessionInspection } from '../../driver/runtime-types.ts'
import type { VelaRuntime } from '../../runtime-sdk-types.ts'
import { CliSessionClient, ensureCliProject } from '../runtime-client.ts'
import { errorMessage } from './components.ts'
import { isModelUsable } from './model-availability.ts'
import type { InteractiveOptions } from './types.ts'

/** Opens or creates the target session on `VelaRuntime`, applies CLI config, and checks model readiness. */
export async function prepareInteractiveSession(
  runtime: VelaRuntime,
  options: InteractiveOptions,
  sessionId: string,
  resume: boolean,
  startup: boolean,
): Promise<{
  session: CliSessionClient
  inspection: RuntimeSessionInspection
  resumed: boolean
  resumeFailure?: string
  setupNext: boolean
}> {
  const projectId = options.noSession
    ? undefined
    : await ensureCliProject(runtime, options.cwd)
  let resumed = false
  let resumeFailure: string | undefined
  try {
    const existing = await runtime.sessions.get(sessionId)
    if (resume) {
      if (existing) {
        resumed = true
      } else {
        resumeFailure = `Session ${sessionId} not found`
        await runtime.sessions.create({
          id: sessionId,
          ...(projectId ? { projectId } : {}),
          location: { environment: 'local', cwd: options.cwd },
        })
      }
    } else if (!existing) {
      await runtime.sessions.create({
        id: sessionId,
        ...(projectId ? { projectId } : {}),
        location: { environment: 'local', cwd: options.cwd },
      })
    }
  } catch (error) {
    resumeFailure = errorMessage(error)
    const fallbackExisting = await runtime.sessions
      .get(sessionId)
      .catch(() => undefined)
    if (!fallbackExisting) {
      await runtime.sessions.create({
        id: sessionId,
        ...(projectId ? { projectId } : {}),
        location: { environment: 'local', cwd: options.cwd },
      })
    }
  }

  const session = new CliSessionClient(
    runtime,
    sessionId,
    undefined,
    options.modelEnv,
  )
  try {
    const setupNext = startup && Boolean(options.agentDir)
    await options.configure(session, { quiet: setupNext, startup, resume })
    const inspection = await session.refresh({ includeEntries: true })
    if (!isModelUsable(session, options.hasUsableModel) && !setupNext) {
      await options.configure(session, { quiet: false, startup, resume })
    }
    return {
      session,
      inspection,
      resumed,
      resumeFailure,
      setupNext,
    }
  } catch (error) {
    session.dispose()
    throw error
  }
}
