import type { ThinkingLevel } from '../../providers/models/index.ts'
import type { ExecutionLocation } from '../execution/types.ts'
import type { ModelMessage } from '../messages.ts'
import type { insertMessageRow } from './db-store.ts'
import type { SessionEntry } from './entries.ts'

export interface StoreSnapshotState {
  entries: SessionEntry[]
  leafId: string | null
  seq: number
  started: boolean
  checked: boolean
  discovered: string[]
  producers: Map<ModelMessage, string>
  ids: Map<ModelMessage, string>
  entryModel: Map<string, string>
  entryThinking: Map<string, ThinkingLevel>
  entryLocations: Map<string, ExecutionLocation>
  pendingExtras: Map<string, Parameters<typeof insertMessageRow>[4]>
  entryIds: Set<string>
  byId: Map<string, SessionEntry>
}

export function captureStoreSnapshot(state: StoreSnapshotState) {
  return {
    len: state.entries.length,
    leaf: state.leafId,
    seq: state.seq,
    started: state.started,
    checked: state.checked,
    discovered: [...state.discovered],
    producers: new Map(state.producers),
    ids: new Map(state.ids),
    entryModel: new Map(state.entryModel),
    entryThinking: new Map(state.entryThinking),
    entryLocations: new Map(state.entryLocations),
    pendingExtras: new Map(state.pendingExtras),
    entryIds: new Set(state.entryIds),
    byId: new Map(state.byId),
  }
}

export function restoreStoreSnapshot(
  state: StoreSnapshotState,
  snap: ReturnType<typeof captureStoreSnapshot>,
): void {
  state.entries.length = snap.len
  state.leafId = snap.leaf
  state.seq = snap.seq
  state.started = snap.started
  state.checked = snap.checked
  state.discovered = snap.discovered
  state.producers = snap.producers
  for (const [target, saved] of [
    [state.ids, snap.ids],
    [state.entryModel, snap.entryModel],
    [state.entryThinking, snap.entryThinking],
    [state.entryLocations, snap.entryLocations],
    [state.pendingExtras, snap.pendingExtras],
    [state.byId, snap.byId],
  ] as const) {
    ;(target as Map<unknown, unknown>).clear()
    for (const [k, v] of saved) (target as Map<unknown, unknown>).set(k, v)
  }
  state.entryIds.clear()
  for (const id of snap.entryIds) state.entryIds.add(id)
}
