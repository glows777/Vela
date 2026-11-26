import type { ModelInput } from '../../shared/provider-types.ts'
import type { ContextManager } from '../context/manager.ts'
import type { ExecutionEnv, ExecutionLocation } from '../execution/types.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import {
  cloneLeaf,
  copyFork,
  executeTreeNavigation,
  forkPoint,
} from './branch-selection.ts'
import {
  buildForkSessionOptions,
  type SessionDefaultState,
  summarizeEntriesForTree,
} from './defaults.ts'
import type { ForkResult, SessionDeps } from './deps.ts'
import {
  entriesToMessages,
  type SessionContext,
  type SessionEntry,
} from './entries.ts'
import { exportBranch } from './export.ts'
import type { SessionStore } from './index.ts'
import type {
  ForkOptions,
  InternalSessionOptions,
  NavigateTreeOptions,
} from './options.ts'
import * as routing from './routing.ts'

export interface SessionBranchHost<Session> {
  id: string
  session: Session
  deps: SessionDeps<Session>
  store: SessionStore
  registry: ToolRegistry
  contextManager: ContextManager
  defaults: SessionDefaultState
  options: InternalSessionOptions
  location: Readonly<ExecutionLocation>
  name: string | undefined
  channel: string | undefined
  parentSession: string | undefined
  autoCompaction: boolean
  model: ModelInput
  maxTokens: number | undefined
  exclusive: <T>(
    what: string,
    task: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>
  start: (signal?: AbortSignal) => Promise<void>
  buildSystem: () => string
  loadBranch: (context: SessionContext) => Promise<void>
  save: () => Promise<void>
  execEnv: (signal?: AbortSignal) => Promise<ExecutionEnv>
}

export async function navigateSessionTree<Session>(
  host: SessionBranchHost<Session>,
  targetId: string,
  options: NavigateTreeOptions = {},
): Promise<{ editorText?: string; cancelled: boolean }> {
  const target = host.store.getEntry(targetId)
  if (!target) throw new Error(`Entry ${targetId} is not in the session`)
  const oldLeafId = host.store.getLeafId()
  const isUser = target.type === 'message' && target.message.role === 'user'
  // Selecting a user message moves to its parent, so only another entry at the leaf is a no-op
  if (targetId === oldLeafId && !isUser) return { cancelled: false }
  return host.exclusive('navigate the session tree', async (signal) => {
    await host.start(signal)
    return executeTreeNavigation({
      session: host.session,
      store: host.store,
      target,
      oldLeafId,
      options,
      signal,
      beforeTree: (s, prep, sig) =>
        host.deps.extensions.beforeTree(s, prep, sig),
      afterTree: (s, event) => host.deps.extensions.tree(s, event),
      summarizeBranch: async (entries, focus, sig) => {
        const branchMessages = entriesToMessages(entries)
        if (!branchMessages.length) return undefined
        return summarizeEntriesForTree(
          host.contextManager,
          host.model,
          host.buildSystem(),
          host.registry.toProviderTools(),
          branchMessages,
          host.maxTokens,
          focus,
          sig,
        )
      },
      loadBranch: (ctx) => host.loadBranch(ctx),
      save: () => host.save(),
    })
  })
}

type BranchSession<Self> = {
  id: string
  location?: ExecutionLocation
  store: SessionStore
  close(): Promise<void>
  seedFrom(parent: Self, branch: SessionEntry[]): Promise<void>
  registry: { spillDir?: string }
}

export async function forkSessionBranch<Session extends BranchSession<Session>>(
  host: SessionBranchHost<Session>,
  entryId: string,
  options: ForkOptions = {},
): Promise<ForkResult<Session>> {
  const position = options.position ?? 'before'
  const point = forkPoint(host.store, entryId, position)
  return host.exclusive('fork', async (signal) => {
    await host.start(signal)
    if (await host.deps.extensions.beforeFork(host.session, entryId, position))
      return { cancelled: true }
    return copyFork(
      host.session,
      point,
      options.sessionId,
      host.deps.openSession,
      buildForkSessionOptions(
        host.defaults,
        host.store,
        host.options,
        host.location,
        host.autoCompaction,
        point.leafId,
        (opts) => routing.unroutedOptions(opts),
      ),
    )
  })
}

export function cloneSessionBranch<Session extends BranchSession<Session>>(
  host: SessionBranchHost<Session>,
  options: Omit<ForkOptions, 'position'> = {},
): Promise<ForkResult<Session>> {
  return forkSessionBranch(host, cloneLeaf(host.store), {
    ...options,
    position: 'at',
  })
}

export async function seedSessionFromBranch<
  Session extends BranchSession<Session>,
>(
  host: SessionBranchHost<Session>,
  parent: Session,
  branch: SessionEntry[],
): Promise<void> {
  await host.store.seedFrom(branch, parent, host.execEnv, {
    parentSpillDir: parent.registry.spillDir,
    spillDir: host.registry.spillDir,
    resolveSourceEnv: (loc) => host.deps.resolveExecution(parent, loc),
  })
  if (branch.length) await host.loadBranch(host.store.buildContext())
  await host.store.flush()
}

export function exportSessionBranch<Session>(
  host: SessionBranchHost<Session>,
  format: 'jsonl' | 'html',
  path?: string,
): Promise<string> {
  return exportBranch({
    id: host.id,
    baseCwd: host.deps.cwd,
    location: host.location,
    path,
    entries: host.store.getBranch(),
    name: host.name,
    model: host.defaults.modelChoice,
    channel: host.channel,
    parentSession: host.parentSession,
    format,
  })
}
