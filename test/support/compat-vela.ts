import { channelInternals } from '../../packages/channels/src/vela.ts'
import { velaInternals as coreInternals } from '../../packages/core/src/vela.ts'

export { createVela, type Vela, type VelaOptions } from '@glows777/vela'

import type { Vela } from '@glows777/vela'
export function velaInternals(vela: Vela) {
  return { ...coreInternals(vela), gateway: channelInternals(vela) }
}
