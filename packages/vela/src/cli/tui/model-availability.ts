import type { VelaSession } from '@glows777/vela-core'

/**
 * Whether a session has a usable model: its name resolves and, when the provider defines one, its
 * credential is configured (`check` is the CLI's credential rule).
 */
export function isModelUsable(
  session: VelaSession,
  check?: (session: VelaSession) => boolean,
): boolean {
  try {
    void session.modelInfo
    return check?.(session) ?? true
  } catch {
    return false
  }
}
