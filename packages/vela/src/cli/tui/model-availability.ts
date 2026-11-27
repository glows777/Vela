import type { CliSessionClient } from '../runtime-client.ts'

/**
 * Whether a session has a usable model: its name resolves and, when the provider defines one, its
 * credential is configured (`check` is the CLI's credential rule).
 */
export function isModelUsable(
  session: CliSessionClient,
  check?: (session: CliSessionClient) => boolean,
): boolean {
  if (!session.modelInfo) return false
  return check?.(session) ?? true
}
