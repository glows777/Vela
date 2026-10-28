import { type Vela, velaInternals } from './vela.ts'
import type { VelaSession } from './vela-session.ts'

/** Resolve the executable shared with this Vela's search tools. */
export function resolveBinary(vela: Vela, name: 'rg' | 'fd'): Promise<string> {
  return velaInternals(vela).resolveBinary(name)
}

/** Apply CLI defaults to an existing/resumed session without freezing dynamic tool eligibility. */
export function setDefaultToolModifiers(
  session: VelaSession,
  entries: readonly string[],
): void {
  session.registry.setDefaultToolModifiers(entries)
}
