import type { BackgroundCommands } from '../tools/background.ts'
import type { SessionOptions } from './options.ts'
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
  /** The host's queue for results produced outside a turn; transient, never written to a session */
  host?: SessionOptions['host']
  /** The session's background commands, installed by the `background` extension; transient too */
  background?: BackgroundCommands
}

const bindings = new WeakMap<object, Routing>()

export const sessionScope = (session: object) => bindings.get(session)?.scope

export const sessionHost = (session: object) => bindings.get(session)?.host

export const sessionBackground = (session: object) =>
  bindings.get(session)?.background

/** @internal Installs a session's background commands (the `background` extension calls this). */
export function setSessionBackground(
  session: object,
  background: BackgroundCommands | undefined,
): void {
  const routing = bindings.get(session)
  if (routing) routing.background = background
  else bindings.set(session, { background })
}

/** The options that bind a session to a route; a copy must not inherit them. */
export function unroutedOptions(options: SessionOptions): SessionOptions {
  const { scope: _scope, channel: _channel, host: _host, ...rest } = options
  return rest
}

/** Initial routing may bind a preopened object; ordinary session options remain first-open-only. */
export function applySessionRouting(
  session: RoutableSession,
  options?: Routing,
): void {
  if (
    options?.scope === undefined &&
    options?.channel === undefined &&
    options?.host === undefined
  )
    return
  const previous = bindings.get(session)
  const next: Routing = {
    scope: options.scope ?? previous?.scope,
    channel: options.channel ?? previous?.channel,
    host: options.host ?? previous?.host,
    background: previous?.background,
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
  const next: Routing = {
    scope: previous?.scope,
    channel,
    host: previous?.host,
    background: previous?.background,
  }
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
