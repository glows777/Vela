import { channelInternals } from '../../packages/channels/dist/vela.js'
import { velaInternals as coreInternals } from '../../packages/core/dist/vela.js'

export { createVela, type Vela, type VelaOptions } from '@glows777/vela'

import type { Vela } from '@glows777/vela'
export function velaInternals(vela: Vela) {
  return { ...coreInternals(vela), gateway: channelInternals(vela) }
}
