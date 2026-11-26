import type { ModelInput } from '../../shared/provider-types.ts'
import type { ExecutionLocation } from '../execution/types.ts'
import type { SessionDefaultState } from './defaults.ts'
import type { SessionDeps } from './deps.ts'
import type { SessionContext } from './entries.ts'
import type { SessionStore } from './index.ts'
import type { InternalSessionOptions } from './options.ts'
import {
  needsRestoredWorkspace,
  restoredLocation,
  switchWorkspace,
} from './relocation.ts'
import * as routing from './routing.ts'

export interface SessionLocationHost<Session> {
  session: Session
  deps: SessionDeps<Session>
  store: SessionStore
  options: InternalSessionOptions
  defaults: SessionDefaultState
  getStarted: () => Promise<void> | undefined
  resetForSwitch: (target: Readonly<ExecutionLocation>) => void
  setDisplayName: (name: string | undefined) => void
  loadBranch: (context: SessionContext) => Promise<void>
  selectModel: (model: ModelInput) => void
  modelRef: () => string
  thinkingLevel: () => SessionDeps<Session>['thinkingLevel']
  prepare: (signal?: AbortSignal) => Promise<unknown>
}

type LocationSession = {
  id: string
  location: Readonly<ExecutionLocation>
  store: SessionStore
  channel?: string
  registry: { setChannel(channel: string): void }
}

export function switchSessionLocation<Session extends LocationSession>(
  host: SessionLocationHost<Session>,
  target: Readonly<ExecutionLocation>,
  moveSignal?: AbortSignal,
): Promise<void> {
  return switchWorkspace(
    host.session,
    host.deps,
    target,
    host.getStarted(),
    () => host.resetForSwitch(target),
    moveSignal,
  )
}

export async function restoreSessionHistory<Session extends LocationSession>(
  host: SessionLocationHost<Session>,
  signal: AbortSignal,
): Promise<boolean> {
  await host.store.flush()
  const saved = await host.store.loadSaved()
  if (!saved) return false
  const target = restoredLocation(saved.location, host.options, host.deps.cwd)
  await switchSessionLocation(host, target, signal)
  host.setDisplayName(saved.name)
  await host.loadBranch(saved)
  if (saved.channel !== undefined) {
    routing.bindSavedChannel(host.session, saved.channel)
  }
  host.defaults.applyOpenChoices(host.options, host.selectModel, {
    store: host.store,
    modelRef: host.modelRef,
    thinkingLevel: host.thinkingLevel,
  })
  if (needsRestoredWorkspace(host.options, target)) await host.prepare(signal)
  return true
}
