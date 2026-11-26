import { sessionScope } from '../session/routing.ts'
import { getToolContextScope } from '../session/scope.ts'

/**
 * @internal Transitional helper bridging `memory()` extension to legacy `SessionScope`
 * without exposing `.scope` on public types until S4b deletes `legacy-channels`.
 */
export function sharedScopeDataDir(
  target: object | undefined,
): string | undefined {
  const scope = target
    ? (sessionScope(target) ?? getToolContextScope(target))
    : undefined
  return scope?.kind === 'shared' ? scope.dataDir : undefined
}
