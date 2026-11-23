import type { VelaSession } from '../../driver/index.ts'
import { errorMessage } from './components.ts'
import { isModelUsable } from './model-availability.ts'
import type { InteractiveOptions } from './types.ts'

/** Validate the candidate before replacing the active TUI session. */
export async function prepareInteractiveSession(
  session: VelaSession,
  options: InteractiveOptions,
  resume: boolean,
  startup: boolean,
): Promise<{
  resources: Awaited<ReturnType<VelaSession['resources']>>
  resumed: boolean
  resumeFailure?: string
  setupNext: boolean
}> {
  let resumed = false
  let resumeFailure: string | undefined
  if (resume) {
    try {
      resumed = await session.resume()
    } catch (error) {
      resumeFailure = errorMessage(error)
    }
  }
  try {
    const resources = await session.resources()
    const setupNext = startup && Boolean(options.agentDir)
    const quiet = setupNext && !isModelUsable(session, options.hasUsableModel)
    options.configure(session, {
      quiet,
      startup,
      defaultTools: resources.defaultTools,
    })
    return { resources, resumed, resumeFailure, setupNext }
  } catch (error) {
    if (!startup) await session.close()
    throw error
  }
}
