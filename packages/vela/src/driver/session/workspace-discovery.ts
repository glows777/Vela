import {
  type ExecutionEnv,
  workspaceDiscovery,
} from '../../shared/execution.ts'
import type { readEnvironmentInventory } from './environment-inventory.ts'

export { workspaceDiscovery }

/** Private fast path for the three discovery loaders, once per prepared location. */
export type InventoryEnv = ExecutionEnv & {
  [workspaceDiscovery]?: (
    contextEnabled: boolean,
    signal: AbortSignal,
  ) => ReturnType<typeof readEnvironmentInventory>
}
