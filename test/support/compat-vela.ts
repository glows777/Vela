import { velaInternals as coreInternals } from '../../packages/vela/src/driver/vela.ts'
import type { ChannelDefinition } from '../../packages/vela/src/legacy-channels/index.ts'
import { LocalStore } from '../../packages/vela/src/legacy-channels/local-store.ts'
import { channelInternals } from '../../packages/vela/src/legacy-channels/vela.ts'

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
