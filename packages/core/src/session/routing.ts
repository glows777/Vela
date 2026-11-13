import type { SessionScope } from './scope.ts'

interface RoutableSession {
  readonly id: string
  channel?: string
  readonly registry: { setChannel(channel: string): void }
  readonly store: { setChannel(channel: string): void }
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
  )
    throw routingConflict(session, previous, next)
  writeRouting(session, next)
}

/** The channel saved in the file becomes the binding. A different channel already bound then throws. */
export function bindSavedChannel(
  session: RoutableSession,
  channel: string,
): void {
  const previous = bindings.get(session)
  const next: Routing = { scope: previous?.scope, channel }
  writeRouting(session, next)
  if (previous?.channel !== undefined && previous.channel !== channel)
    throw routingConflict(session, previous, next)
}

function writeRouting(session: RoutableSession, next: Routing): void {
  if (next.scope) next.scope = Object.freeze({ ...next.scope })
  bindings.set(session, next)
  if (next.channel !== undefined) {
    session.channel = next.channel
    session.registry.setChannel(next.channel)
    session.store.setChannel(next.channel)
  }
}

function routingConflict(
  session: RoutableSession,
  previous: Routing,
  next: Routing,
): Error {
  const error = new Error(
    `SessionRoutingConflictError: session ${session.id} routing conflict: ${JSON.stringify(previous)} -> ${JSON.stringify(next)}`,
  )
  error.name = 'SessionRoutingConflictError'
  return error
}
