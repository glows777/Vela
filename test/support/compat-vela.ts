import type { ChannelDefinition } from '@glows777/vela-channels'
import { LocalStore } from '../../packages/channels/src/local-store.ts'
import { channelInternals } from '../../packages/channels/src/vela.ts'
import { velaInternals as coreInternals } from '../../packages/core/src/vela.ts'

export { createVela, type Vela, type VelaOptions } from '@glows777/vela'

import type { Vela } from '@glows777/vela'
export function velaInternals(vela: Vela) {
  return { ...coreInternals(vela), gateway: channelInternals(vela) }
}

/** Private fixture access to hold Local startup at its storage boundary. */
export function localStore(channel: ChannelDefinition): LocalStore {
  if (!('store' in channel) || !(channel.store instanceof LocalStore))
    throw new Error('Expected the built-in Local channel')
  return channel.store
}
