import type { SessionScope } from './scope.ts'

interface RoutableSession {
  readonly id: string
  channel?: string
  readonly registry: { setChannel(channel: string): void }
}

interface Routing {
  scope?: Readonly<SessionScope>
  channel?: string
}

const bindings = new WeakMap<object, Routing>()

export const sessionScope = (session: object) => bindings.get(session)?.scope

/** Initial routing may bind a preopened object; ordinary session options remain first-open-only. */
export function applySessionRouting(
  session: RoutableSession,
  options?: Routing,
): void {
  if (options?.scope === undefined && options?.channel === undefined) return
  const previous = bindings.get(session)
  const next: Routing = {
    scope: options.scope ?? previous?.scope,
    channel: options.channel ?? previous?.channel,
  }
  if (
    previous &&
    ((previous.channel !== undefined && previous.channel !== next.channel) ||
      (previous.scope !== undefined &&
        (previous.scope.id !== next.scope?.id ||
          previous.scope.kind !== next.scope?.kind ||
          previous.scope.dataDir !== next.scope?.dataDir)))
  ) {
    const error = new Error(
      `SessionRoutingConflictError: session ${session.id} routing conflict: ${JSON.stringify(previous)} -> ${JSON.stringify(next)}`,
    )
    error.name = 'SessionRoutingConflictError'
    throw error
  }
  if (next.scope) next.scope = Object.freeze({ ...next.scope })
  bindings.set(session, next)
  if (next.channel !== undefined) {
    session.channel = next.channel
    session.registry.setChannel(next.channel)
  }
}
