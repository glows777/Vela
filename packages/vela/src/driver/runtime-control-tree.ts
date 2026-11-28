import { join } from 'node:path'
import type { ContextManager } from './context/manager.ts'
import { resolveRequestSnapshot } from './context/request.ts'
import type { ModelMessage } from './messages.ts'
import { createExtensionSessionView } from './runtime-extensions.ts'
import {
  type DriverSharedState,
  type PreparedSessionEnv,
  prepareSessionSetup,
} from './runtime-session-setup.ts'
import {
  cloneLeaf,
  executeTreeNavigation,
  forkPoint,
} from './session/branch-selection.ts'
import { entriesToMessages, type SessionEntry } from './session/entries.ts'
import { SessionStore } from './session/index.ts'
import type { ForkOptions, NavigateTreeOptions } from './session/options.ts'
import { newSessionId } from './session/session-id.ts'

export interface TreeControlDeps {
  state: DriverSharedState
  withSessionLock: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  assertIdle: (sessionId: string, action: string) => void
  loadStore: (sessionId: string) => Promise<{
    store: SessionStore
    saved: Awaited<ReturnType<SessionStore['loadSaved']>>
  }>
  buildTrackerAndContext: (options: {
    store: SessionStore
    saved: Awaited<ReturnType<SessionStore['loadSaved']>>
    prepared: PreparedSessionEnv
    sessionId: string
    projectId: string | null
  }) => { contextManager: ContextManager }
}

/** Tree inspection, branch navigation, labeling, forking, and cloning controls. */
export function createTreeControl(deps: TreeControlDeps) {
  const {
    state,
    withSessionLock,
    assertIdle,
    loadStore,
    buildTrackerAndContext,
  } = deps

  const fork = (
    sessionId: string,
    entryId: string,
    options: ForkOptions = {},
  ): Promise<{
    cancelled: boolean
    sessionId?: string
    selectedText?: string
  }> =>
    withSessionLock(sessionId, async () => {
      assertIdle(sessionId, 'forking')
      const row = state.db.get<{
        project_id: string | null
        kind: string
        driver: string
      }>(
        'SELECT project_id, kind, driver FROM sessions WHERE id = ?',
        sessionId,
      )
      if (!row) throw new Error(`Session ${sessionId} not found`)
      const { store, saved } = await loadStore(sessionId)
      const position = options.position ?? 'before'
      const point = forkPoint(store, entryId, position)
      const controller = new AbortController()
      const messages: ModelMessage[] = [...(saved?.messages ?? [])]
      const prepared = await prepareSessionSetup({
        state,
        sessionId,
        projectId: row.project_id,
        saved,
        store,
        messages,
        signal: controller.signal,
        attachMcp: false,
        allowNoModel: true,
      })
      try {
        const extView = createExtensionSessionView({
          sessionId,
          cwd: prepared.location.cwd,
          name: prepared.sessionName,
          channel: prepared.boundChannel,
          messages,
          registry: prepared.registry,
          store,
          eventBus: state.options.eventBus,
          projectId: row.project_id,
          signal: controller.signal,
          buildSystem: (sections) =>
            prepared!.builder.build({
              sessionId,
              activeTools: prepared!.registry.getActiveTools(),
              deferredToolSummary: prepared!.registry.getDeferredToolSummary(),
              extensionSections: sections ?? prepared!.runtimeSections,
            }),
        })
        if (
          await prepared.extensionRunner.beforeFork(extView, entryId, position)
        ) {
          return { cancelled: true }
        }
        const branch =
          point.leafId === null ? [] : store.getBranch(point.leafId)
        const targetId = options.sessionId ?? newSessionId()
        const targetStore = new SessionStore(targetId, state.db, {
          blobsDir: state.options.blobs.rootDir,
          location: prepared.location,
          logger: state.logger,
        })
        const parentSpillDir = join(
          state.options.agentDir,
          'sessions',
          sessionId,
          'tool-results',
        )
        const targetSpillDir = join(
          state.options.agentDir,
          'sessions',
          targetId,
          'tool-results',
        )
        await targetStore.seedFrom(
          branch,
          { id: sessionId, store, location: prepared.location },
          prepared.resolveEnv,
          {
            parentSpillDir,
            spillDir: targetSpillDir,
            resolveSourceEnv: () => prepared.resolveEnv(),
          },
        )
        const childKind = row.project_id ? 'work' : 'chat'
        const existingTarget = state.db.get<{ id: string }>(
          'SELECT id FROM sessions WHERE id = ?',
          targetId,
        )
        if (!existingTarget) {
          const now = new Date().toISOString()
          state.db.run(
            `INSERT INTO sessions (
               id, project_id, kind, driver, parent_session_id, model, thinking_level, location_json, state, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
            targetId,
            row.project_id,
            childKind,
            row.driver,
            sessionId,
            saved?.model ?? null,
            saved?.thinkingLevel ?? null,
            JSON.stringify(prepared.location),
            now,
            now,
          )
        } else {
          state.db.run(
            `UPDATE sessions
             SET project_id = ?, kind = ?, driver = ?, parent_session_id = ?, model = COALESCE(?, model), thinking_level = COALESCE(?, thinking_level)
             WHERE id = ?`,
            row.project_id,
            childKind,
            row.driver,
            sessionId,
            saved?.model ?? null,
            saved?.thinkingLevel ?? null,
            targetId,
          )
        }
        await targetStore.flush()
        return {
          cancelled: false,
          sessionId: targetId,
          ...(point.selectedText === undefined
            ? {}
            : { selectedText: point.selectedText }),
        }
      } finally {
        await prepared.releaseSession()
      }
    })

  return {
    async tree(sessionId: string) {
      const { store } = await loadStore(sessionId)
      return {
        tree: store.getTree(),
        branch: store.getBranch(),
        entries: store.getEntries(),
        leafId: store.getLeafId(),
      }
    },

    navigateTree(
      sessionId: string,
      targetId: string,
      options: NavigateTreeOptions = {},
    ): Promise<{
      editorText?: string
      cancelled: boolean
      branch: SessionEntry[]
    }> {
      return withSessionLock(sessionId, async () => {
        assertIdle(sessionId, 'navigating the session tree')
        const row = state.db.get<{ project_id: string | null }>(
          'SELECT project_id FROM sessions WHERE id = ?',
          sessionId,
        )
        if (!row) throw new Error(`Session ${sessionId} not found`)
        const { store, saved } = await loadStore(sessionId)
        const target = store.getEntry(targetId)
        if (!target) {
          throw new Error(`Entry ${targetId} is not in the session`)
        }
        const oldLeafId = store.getLeafId()
        const isUser =
          target.type === 'message' && target.message.role === 'user'
        if (targetId === oldLeafId && !isUser) {
          return { cancelled: false, branch: store.getBranch() }
        }
        const controller = new AbortController()
        const messages: ModelMessage[] = [...(saved?.messages ?? [])]
        const prepared = await prepareSessionSetup({
          state,
          sessionId,
          projectId: row.project_id,
          saved,
          store,
          messages,
          signal: controller.signal,
          attachMcp: false,
          allowNoModel: !options.summarize,
        })
        try {
          const { contextManager } = buildTrackerAndContext({
            store,
            saved,
            prepared,
            sessionId,
            projectId: row.project_id,
          })
          const systemPrompt = prepared.builder.build({
            sessionId,
            activeTools: prepared.registry.getActiveTools(),
            deferredToolSummary: prepared.registry.getDeferredToolSummary(),
            extensionSections: prepared.runtimeSections,
          })
          const extView = createExtensionSessionView({
            sessionId,
            cwd: prepared.location.cwd,
            name: prepared.sessionName,
            channel: prepared.boundChannel,
            messages,
            registry: prepared.registry,
            store,
            eventBus: state.options.eventBus,
            projectId: row.project_id,
            signal: controller.signal,
            buildSystem: (sections) =>
              prepared!.builder.build({
                sessionId,
                activeTools: prepared!.registry.getActiveTools(),
                deferredToolSummary:
                  prepared!.registry.getDeferredToolSummary(),
                extensionSections: sections ?? prepared!.runtimeSections,
              }),
          })
          const result = await executeTreeNavigation({
            session: extView,
            store,
            target,
            oldLeafId,
            options,
            signal: controller.signal,
            beforeTree: (s, prep, sig) =>
              prepared.extensionRunner.beforeTree(s, prep, sig),
            afterTree: (s, event) => prepared.extensionRunner.tree(s, event),
            summarizeBranch: async (entries, focus, sig) => {
              const branchMessages = entriesToMessages(entries)
              if (!branchMessages.length) return undefined
              const req = await resolveRequestSnapshot(
                prepared.resolved!.model,
                systemPrompt,
                prepared.registry.toProviderTools(),
                branchMessages,
                sig,
                prepared.resolved!.info.maxTokens,
              )
              return contextManager.summarizeBranch(req, 0, focus)
            },
            loadBranch: async () => {},
            save: () => store.flush(),
          })
          return {
            ...result,
            branch: store.getBranch(),
          }
        } finally {
          await prepared.releaseSession()
        }
      })
    },

    async setLabel(
      sessionId: string,
      entryId: string,
      label: string | undefined,
    ): Promise<void> {
      const { store } = await loadStore(sessionId)
      store.appendLabelChange(
        entryId,
        label?.replace(/[\r\n]+/g, ' ').trim() || undefined,
      )
      await store.flush()
    },

    fork,

    async clone(
      sessionId: string,
      options: Omit<ForkOptions, 'position'> = {},
    ) {
      const { store } = await loadStore(sessionId)
      const leafId = cloneLeaf(store)
      return fork(sessionId, leafId, { ...options, position: 'at' })
    },
  }
}
