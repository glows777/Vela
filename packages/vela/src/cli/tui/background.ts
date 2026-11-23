import type { VelaSession } from '../../driver/index.ts'
import { errorMessage } from './components.ts'

/**
 * Ctrl+B: moves every shell command the session runs in the foreground to the background, the
 * model's `bash` call and your own `!` command alike. The settled row names the job, so a move
 * stays quiet; with nothing in the foreground the key says why nothing happened.
 */
export async function backgroundRunning(
  session: VelaSession,
  notice: (text: string, level: 'dim' | 'error') => void,
): Promise<void> {
  try {
    const ids = await session.backgroundTasks()
    if (!ids.length) notice('No foreground command to background', 'dim')
  } catch (error) {
    notice(errorMessage(error), 'error')
  }
}
