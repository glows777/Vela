import type { SessionOptions } from './options.ts'

interface RoutableSession {
  readonly id: string
  channel?: string
  readonly registry: { setChannel(channel: string): void }
  readonly store: { setChannel(channel: string): void }
}

interface Routing {
  channel?: string
}

const bindings = new WeakMap<object, Routing>()

/** The options that bind a session to a route; a copy must not inherit them. */
export function unroutedOptions(options: SessionOptions): SessionOptions {
  const { channel: _channel, ...rest } = options
  return rest
}

/** Initial routing may bind a preopened object; ordinary session options remain first-open-only. */
export function applySessionRouting(
  session: RoutableSession,
  options?: Routing,
): void {
  if (options?.channel === undefined) return
  const previous = bindings.get(session)
  const next: Routing = {
    channel: options.channel ?? previous?.channel,
  }
  if (
    previous &&
    previous.channel !== undefined &&
    previous.channel !== next.channel
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
  const next: Routing = {
    channel,
  }
  writeRouting(session, next)
  if (previous?.channel !== undefined && previous.channel !== channel)
    throw routingConflict(session, previous, next)
}

function writeRouting(session: RoutableSession, next: Routing): void {
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
