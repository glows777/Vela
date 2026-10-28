/** Compatibility assembly; the SDK implementation itself lives in vela-core.ts. */

import type { ChannelVela } from './channels/vela.ts'
import { channelInternals } from './channels/vela.ts'
import { velaInternals as coreInternals } from './vela-core.ts'

export {
  type ChannelVela as Vela,
  type ChannelVelaOptions as VelaOptions,
  createChannelVela as createVela,
} from './channels/vela.ts'

/** @internal Backward-compatible test access; production frontends use diagnostics. */
export function velaInternals(vela: ChannelVela) {
  return { ...coreInternals(vela), gateway: channelInternals(vela) }
}
