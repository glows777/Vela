import type { CliSessionClient } from '../runtime-client.ts'
import { errorMessage } from './components.ts'

/**
 * Ctrl+B: moves every shell command the session runs in the foreground to the background, the
 * model's `bash` call and your own `!` command alike.
 */
export async function backgroundRunning(
  session: CliSessionClient,
  notice: (text: string, level: 'dim' | 'error') => void,
): Promise<void> {
  try {
    const ids = await session.runtime.jobs.promoteForeground(session.id)
    if (!ids.length) notice('No foreground command to background', 'dim')
  } catch (error) {
    notice(errorMessage(error), 'error')
  }
}
