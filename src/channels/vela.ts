import type { LoadedExtension as CoreLoadedExtension } from '../core.ts'
import {
  type VelaOptions as CoreOptions,
  type Vela as CoreVela,
  createVela as createCoreVela,
} from '../core.ts'
import { inspectVela } from '../diagnostics.ts'
import type {
  VelaExtension as CoreExtension,
  ExtensionAPI as CoreExtensionAPI,
} from '../extension-api.ts'
import { silentLogger } from '../extension-api.ts'
import { ChannelGateway } from './gateway.ts'
import type { ChannelDefinition } from './types.ts'

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
}
export interface ChannelVela extends Omit<CoreVela, 'extensions'> {
  extensions(): LoadedChannelExtension[]
  channels(): { name: string; description: string }[]
  startChannels(): Promise<void>
  runningChannels(): string[]
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
  let core: CoreVela
  let gateway: ChannelGateway | undefined
  const runtime = (api?: CoreExtensionAPI): ChannelGateway =>
    (gateway ??= new ChannelGateway({
      dataDir: api?.dataDir ?? core.dataDir,
      session: (id, sessionOptions) => core.session(id, sessionOptions),
      find: (id) => core.sessions().find((session) => session.id === id),
      idleMs: channelIdleMs,
      logger,
    }))
  const registered: string[][] = []
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
  core = createCoreVela({
    ...options,
    extensions,
    onSessionSaved(id) {
      gateway?.sessionSaved(id)
      options.onSessionSaved?.(id)
    },
    beforeDispose: options.beforeDispose
      ? async () => {
          const errors: unknown[] = []
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
      : () => runtime().stopAll(),
  })
  gateways.set(core, runtime())
  const loaded = core.extensions.bind(core)
  return Object.assign(core, {
    extensions: () =>
      loaded().map((entry, index) => ({
        ...entry,
        channels: [...registered[index]!],
      })),
    channels: () => runtime().list(),
    runningChannels: () => runtime().running(),
    async startChannels() {
      await core.ready()
      await runtime().startAll(inspectVela(core).tools.map((tool) => tool.name))
    },
  })
}
