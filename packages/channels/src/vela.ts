import type { LoadedExtension as CoreLoadedExtension } from '@glows777/vela-core'
import {
  type VelaOptions as CoreOptions,
  type Vela as CoreVela,
  createVela as createCoreVela,
} from '@glows777/vela-core'
import { inspectVela } from '@glows777/vela-core/diagnostics'
import type {
  VelaExtension as CoreExtension,
  ExtensionAPI as CoreExtensionAPI,
} from '@glows777/vela-core/extension-api'
import { silentLogger } from '@glows777/vela-core/extension-api'
import { EventReceiver } from './event-receiver.ts'
import { ChannelGateway } from './gateway.ts'
import type { ChannelDefinition, ChannelEvent } from './types.ts'

export interface ChannelExtensionAPI extends CoreExtensionAPI {
  registerChannel(channel: ChannelDefinition): void
}
export type ChannelExtension = (
  api: ChannelExtensionAPI,
) => void | Promise<void>
export interface LoadedChannelExtension extends CoreLoadedExtension {
  channels: string[]
}
export interface ChannelVelaOptions extends Omit<CoreOptions, 'extensions'> {
  extensions?: ChannelExtension[]
  /** Default 10 minutes; 0 closes idle conversations after each reply. */
  channelIdleMs?: number
  /** Unmatched events may reach this existing enabled top-level chat; unset drops them. */
  eventDefaultTarget?: { channel: string; chatId: string }
}
export interface ChannelVela extends Omit<CoreVela, 'extensions'> {
  extensions(): LoadedChannelExtension[]
  channels(): { name: string; description: string }[]
  startChannels(): Promise<void>
  runningChannels(): string[]
  /** Enqueues to matching subscriptions, without waiting for model execution. Channels must be started. */
  publishEvent(event: ChannelEvent): Promise<void>
}

const gateways = new WeakMap<CoreVela, ChannelGateway>()
/** @internal Test-only implementation access; frontends use runningChannels(). */
export function channelInternals(vela: CoreVela): ChannelGateway {
  const gateway = gateways.get(vela)
  if (!gateway) throw new Error('Not a channel-aware Vela')
  return gateway
}

/** Composes the channel runtime using only core's supported contracts. */
export function createChannelVela(
  options: ChannelVelaOptions = {},
): ChannelVela {
  const { channelIdleMs } = options
  if (
    channelIdleMs !== undefined &&
    !(
      Number.isInteger(channelIdleMs) &&
      channelIdleMs >= 0 &&
      channelIdleMs <= 2 ** 31 - 1
    )
  )
    throw new Error(
      `channelIdleMs must be a whole number of milliseconds from 0 to ${2 ** 31 - 1}; got ${channelIdleMs}`,
    )
  const logger = options.logger ?? silentLogger
  const receiverConfig = options.extensionConfig?.channel?.eventReceiver
  const receiver =
    receiverConfig === undefined
      ? undefined
      : new EventReceiver(
          receiverConfig,
          (event) => runtime().events.publish(event),
          logger,
        )
  let stopping = false
  let core: CoreVela
  let gateway: ChannelGateway | undefined
  const runtime = (api?: CoreExtensionAPI): ChannelGateway =>
    (gateway ??= new ChannelGateway({
      dataDir: api?.dataDir ?? core.dataDir,
      session: (id, sessionOptions) => core.session(id, sessionOptions),
      find: (id) => core.sessions().find((session) => session.id === id),
      idleMs: channelIdleMs,
      eventDefaultTarget: options.eventDefaultTarget,
      logger,
    }))
  const registered: string[][] = []
  const stop = async () => {
    stopping = true
    const errors: unknown[] = []
    try {
      await receiver?.stop()
    } catch (error) {
      errors.push(error)
    }
    try {
      await runtime().stopAll()
    } catch (error) {
      errors.push(error)
    }
    try {
      await options.beforeDispose?.()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length)
      throw new AggregateError(errors, 'Channel ingress shutdown failed')
  }
  const extensions: CoreExtension[] = (options.extensions ?? []).map(
    (extension, index) => {
      const name = extension.name || `extension-${index + 1}`
      registered[index] = []
      return {
        [name]: (api: CoreExtensionAPI) =>
          extension({
            ...api,
            registerChannel(channel) {
              runtime(api).register(channel)
              registered[index]!.push(channel.name)
            },
          }),
      }[name]!
    },
  )
  extensions.push(function channel(api) {
    runtime(api).events.register(api)
  })
  core = createCoreVela({
    ...options,
    extensions,
    onSessionSaved(id) {
      gateway?.sessionSaved(id)
      options.onSessionSaved?.(id)
    },
    beforeDispose:
      receiver || options.beforeDispose
        ? stop
        : () => {
            stopping = true
            return runtime().stopAll()
          },
  })
  gateways.set(core, runtime())
  const loaded = core.extensions.bind(core)
  return Object.assign(core, {
    extensions: () =>
      loaded().map((entry, index) => ({
        ...entry,
        channels: [...(registered[index] ?? [])],
      })),
    channels: () => runtime().list(),
    runningChannels: () => runtime().running(),
    publishEvent: (event: ChannelEvent) => runtime().events.publish(event),
    async startChannels() {
      await core.ready()
      await runtime().startAll(inspectVela(core).tools.map((tool) => tool.name))
      if (!stopping && runtime().running().length) await receiver?.start()
    },
  })
}
