import type { ExecutionEnv } from '../execution/types.ts'
import type { readEnvironmentInventory } from './environment-inventory.ts'
/** Private fast path for the three discovery loaders, once per prepared location. */
export const workspaceDiscovery = Symbol.for('vela.private.workspaceDiscovery')
export type InventoryEnv = ExecutionEnv & {
  [workspaceDiscovery]?: (
    contextEnabled: boolean,
    signal: AbortSignal,
  ) => ReturnType<typeof readEnvironmentInventory>
}
