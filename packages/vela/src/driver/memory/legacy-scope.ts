import type { SessionScope } from '../session/scope.ts'

/**
 * @internal Transitional helper bridging `memory()` extension to legacy `SessionScope`
 * without violating the light-builtin internal-access boundary until S4b deletes `legacy-channels`.
 */
export function sharedScopeDataDir(
  target: { scope?: Readonly<SessionScope> } | undefined,
): string | undefined {
  return target?.scope?.kind === 'shared' ? target.scope.dataDir : undefined
}
