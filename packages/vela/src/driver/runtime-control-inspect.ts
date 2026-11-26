import { randomUUID } from 'node:crypto'
import { resolveProviderTools } from '../providers/index.ts'
import { supportedThinkingLevels } from '../providers/models/catalog.ts'
import { THINKING_LEVELS } from '../providers/models/index.ts'
import { listPendingUserInboxTexts } from '../runtime/control-inbox.ts'
import type { VelaLimits } from '../shared/limits.ts'
import type { ModelMessage } from './messages.ts'
import { createRuntimeBackgroundController } from './runtime-background.ts'
import {
  createExtensionSessionView,
  NATIVE_COMMANDS,
  runNativeRuntimeCommand,
} from './runtime-extensions.ts'
import {
  type DriverSharedState,
  type PreparedSessionEnv,
  prepareSessionSetup,
} from './runtime-session-setup.ts'
import type {
  RuntimePromptPreview,
  RuntimeSessionInspection,
} from './runtime-types.ts'
import {
  type BashExecutionEntry,
  bashExecutionToText,
} from './session/entries.ts'
import type { SessionStore } from './session/index.ts'
import { formatSkillsForPrompt } from './skills/loader.ts'
import { OutputTail } from './tools/output-tail.ts'
import { type BashResult, runBash } from './tools/shell.ts'
import type { TokenTracker } from './usage/tracker.ts'

export interface InspectAndBashDeps {
  state: DriverSharedState
  isSessionRunning: (sessionId: string) => boolean
  loadStore: (sessionId: string) => Promise<{
    store: SessionStore
    saved: Awaited<ReturnType<SessionStore['loadSaved']>>
  }>
  emitNotify: (
    sessionId: string,
    projectId: string | null,
    message: string,
    level?: 'info' | 'warning' | 'error',
  ) => void
  buildTrackerAndContext: (options: {
    store: SessionStore
    saved: Awaited<ReturnType<SessionStore['loadSaved']>>
    prepared: PreparedSessionEnv
    sessionId: string
    projectId: string | null
  }) => { tracker: TokenTracker; effectiveLimits: VelaLimits }
}

/** Session inspection, user `!` bash execution, abort, and slash command execution. */
export function createInspectAndBashControl(deps: InspectAndBashDeps) {
  const {
    state,
    isSessionRunning,
    loadStore,
    emitNotify,
    buildTrackerAndContext,
  } = deps

  return {
    async inspect(
      sessionId: string,
      options?: { previewPrompt?: boolean },
    ): Promise<RuntimeSessionInspection> {
      const row = state.db.get<{
        project_id: string | null
        parent_session_id: string | null
      }>(
        'SELECT project_id, parent_session_id FROM sessions WHERE id = ?',
        sessionId,
      )
      if (!row) throw new Error(`Session ${sessionId} not found`)
      const { store, saved } = await loadStore(sessionId)
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
      const { tracker, effectiveLimits } = buildTrackerAndContext({
        store,
        saved,
        prepared,
        sessionId,
        projectId: row.project_id,
      })
      const activeTools = prepared.registry.getActiveTools()
      const allTools = prepared.registry.getAllTools().map((t) => t.name)
      const availableThinkingLevels = prepared.resolved
        ? supportedThinkingLevels(prepared.resolved.info, THINKING_LEVELS)
        : [...THINKING_LEVELS]
      const extCommands = prepared.extensionRunner.commands().map((c) => ({
        name: c.name,
        ...(c.description ? { description: c.description } : {}),
        source: 'extension' as const,
        extension: c.extension,
      }))
      const commands = [...NATIVE_COMMANDS, ...extCommands]
      const runningJobs =
        state.sessionBackgrounds
          .get(sessionId)
          ?.tasks()
          .filter((t) => t.snapshot.state === 'running') ?? []
      const liveSteering =
        state.activeSteering
          .get(sessionId)
          ?.map((m) =>
            typeof m.content === 'string'
              ? m.content
              : JSON.stringify(m.content),
          ) ?? []
      const dbSteering = listPendingUserInboxTexts(state.db, sessionId)

      let promptSnapshot: RuntimePromptPreview | undefined
      if (options?.previewPrompt) {
        const systemPrompt = prepared.builder.build({
          sessionId,
          activeTools,
          deferredToolSummary: prepared.registry.getDeferredToolSummary(),
          extensionSections: prepared.runtimeSections,
        })
        const resolvedTools = await resolveProviderTools(
          prepared.resolved?.model ?? '',
          prepared.registry.toProviderTools(),
        )
        const skillsStr =
          formatSkillsForPrompt(
            prepared.resources.skills,
            activeTools.map((t) => t.name),
          ) ?? ''
        const ctxParams = {
          extensionSections: prepared.runtimeSections,
          deferredToolSummary: prepared.registry.getDeferredToolSummary(),
          sessionId,
          activeTools,
        }
        promptSnapshot = {
          windowTokens: tracker.contextWindow,
          systemPrompt,
          systemPromptChars: systemPrompt.length,
          toolDescriptionChars: JSON.stringify(resolvedTools.toolDefinitions)
            .length,
          skillsChars: skillsStr.length,
          extensionSections: { ...prepared.runtimeSections },
          stages: prepared.builder.status(ctxParams),
        }
      }

      const modelInfo = prepared.resolved
        ? {
            ...prepared.resolved.info,
            ...(typeof prepared.modelInput === 'string'
              ? (() => {
                  const provider = prepared.modelInput.slice(
                    0,
                    prepared.modelInput.indexOf('/'),
                  )
                  const plan = prepared.activeModels.planLabel(
                    provider,
                    prepared.boundChannel,
                  )
                  return plan ? { planLabel: plan } : {}
                })()
              : {}),
          }
        : undefined

      return {
        sessionId,
        cwd: prepared.location.cwd,
        ...(prepared.sessionName ? { name: prepared.sessionName } : {}),
        ...(prepared.boundChannel ? { channel: prepared.boundChannel } : {}),
        ...(row.parent_session_id
          ? { parentSession: row.parent_session_id }
          : {}),
        persistence:
          state.db.path === ':memory:'
            ? { type: 'memory' as const }
            : { type: 'file' as const, path: state.db.path },
        ...(modelInfo ? { modelInfo } : {}),
        ...(prepared.modelError ? { modelError: prepared.modelError } : {}),
        thinkingLevel: prepared.thinkingLevel,
        availableThinkingLevels,
        limits: effectiveLimits,
        usage: (() => {
          const snap = tracker.snapshot()
          return {
            tokens: snap.tokens,
            contextWindow: snap.contextWindow,
            percent: snap.percent,
            totals: snap.totals,
          }
        })(),
        entries: store.getEntries(),
        branch: store.getBranch(),
        leafId: store.getLeafId(),
        allTools,
        activeTools: activeTools.map((t) => t.name),
        commands,
        extensions: prepared.extensionRunner.loaded().map((e) => ({
          name: e.name,
          tools: [...e.tools],
          providers: [...e.providers],
          commands: [...e.commands],
        })),
        extensionErrors: prepared.extensionErrors,
        hooks: prepared.extensionRunner.toolHandlers(),
        runningJobs,
        isRunning: isSessionRunning(sessionId),
        isBashRunning: state.activeBash.has(sessionId),
        queuedSteering: [...dbSteering, ...liveSteering],
        resources: {
          trusted: prepared.resources.trusted,
          contextFiles: prepared.resources.contextFiles.map((f) => ({ ...f })),
          skills: prepared.resources.skills.map(
            ({ name, description, filePath, disableModelInvocation }) => ({
              name,
              description,
              filePath,
              ...(disableModelInvocation ? { disableModelInvocation } : {}),
            }),
          ),
          promptTemplates: prepared.resources.promptTemplates.map(
            ({ name, description, argumentHint }) => ({
              name,
              description,
              ...(argumentHint ? { argumentHint } : {}),
            }),
          ),
          ...(prepared.projectDefaultTools
            ? { defaultTools: [...prepared.projectDefaultTools] }
            : {}),
          ...(prepared.enabledModels
            ? { enabledModels: [...prepared.enabledModels] }
            : {}),
        },
        ...(promptSnapshot ? { promptSnapshot } : {}),
      }
    },

    async execBash(
      sessionId: string,
      command: string,
      options: { excludeFromContext?: boolean; id?: string } = {},
    ): Promise<BashResult> {
      if (state.activeBash.has(sessionId)) {
        throw new Error(
          'A shell command is already running: wait for it or call abortBash()',
        )
      }
      const row = state.db.get<{ project_id: string | null }>(
        'SELECT project_id FROM sessions WHERE id = ?',
        sessionId,
      )
      if (!row) throw new Error(`Session ${sessionId} not found`)
      const { store, saved } = await loadStore(sessionId)
      const controller = new AbortController()
      state.activeBash.set(sessionId, controller)
      try {
        const prepared = await prepareSessionSetup({
          state,
          sessionId,
          projectId: row.project_id,
          saved,
          store,
          messages: [...(saved?.messages ?? [])],
          signal: controller.signal,
          attachMcp: false,
          allowNoModel: true,
        })
        const env = await prepared.resolveEnv()
        controller.signal.throwIfAborted()
        let bg = state.sessionBackgrounds.get(sessionId)
        if (!bg) {
          bg = createRuntimeBackgroundController({
            db: state.db,
            sessionId,
            runId: randomUUID(),
            wakeSession: state.options.wakeSession,
            location: prepared.location,
          })
          state.sessionBackgrounds.set(sessionId, bg)
        }
        const extView = createExtensionSessionView({
          sessionId,
          cwd: prepared.location.cwd,
          name: prepared.sessionName,
          channel: prepared.boundChannel,
          messages: [...(saved?.messages ?? [])],
          registry: prepared.registry,
          store,
          eventBus: state.options.eventBus,
          projectId: row.project_id,
          signal: controller.signal,
        })
        await prepared.ensureSessionStarted(extView)
        const output = new OutputTail()
        const start = (signal: AbortSignal) =>
          runBash(command, {
            env,
            signal,
            onDelta: (delta) =>
              state.options.eventBus?.emitDelta({
                type: 'bash_output_delta',
                sessionId,
                ...(options.id ? { bashId: options.id } : {}),
                delta,
              }),
            output,
          })
        const fg = bg.watch({
          command,
          signal: controller.signal,
          output,
          start,
          excludeFromContext: options.excludeFromContext,
          exit: (settled) => ({
            exitCode: settled.exitCode,
            spillPath: settled.fullOutputPath,
          }),
        })
        const runPromise = Promise.race([
          fg.result.then((value) => ({ type: 'result' as const, value })),
          fg.detached.then((admission) => ({
            type: 'detached' as const,
            admission,
          })),
        ])
        state.activeBashPromises.add(runPromise)
        const outcome = await runPromise.finally(() => {
          state.activeBashPromises.delete(runPromise)
        })
        const result: BashResult =
          outcome.type === 'result'
            ? outcome.value
            : {
                output: outcome.admission.output,
                exitCode: undefined,
                cancelled: false,
                truncated: outcome.admission.truncated,
                backgroundTaskId: outcome.admission.id,
              }
        const entry: Omit<BashExecutionEntry, 'id' | 'parentId' | 'timestamp'> =
          {
            type: 'bash_execution',
            command,
            output: result.output,
            ...(result.exitCode === undefined
              ? {}
              : { exitCode: result.exitCode }),
            cancelled: result.cancelled,
            truncated: result.truncated,
            ...(result.fullOutputPath
              ? { fullOutputPath: result.fullOutputPath }
              : {}),
            ...(result.backgroundTaskId
              ? { backgroundTaskId: result.backgroundTaskId }
              : {}),
            ...(options.excludeFromContext ? { excludeFromContext: true } : {}),
          }
        if (isSessionRunning(sessionId)) {
          const list = state.pendingBashBySession.get(sessionId) ?? []
          list.push(entry as BashExecutionEntry)
          state.pendingBashBySession.set(sessionId, list)
        } else {
          const msg = options.excludeFromContext
            ? undefined
            : ({
                role: 'user',
                content: bashExecutionToText(entry as BashExecutionEntry),
              } satisfies ModelMessage)
          store.appendBashExecution(entry, msg)
          await store.flush()
        }
        return result
      } finally {
        state.activeBash.delete(sessionId)
      }
    },

    abortBash(sessionId: string): void {
      state.activeBash.get(sessionId)?.abort()
    },

    async runCommand(
      sessionId: string,
      input: string,
    ): Promise<{ handled: boolean }> {
      const trimmed = input.trim()
      const match = trimmed.match(/^\/(\S+)(?:\s+([\s\S]*))?$/)
      if (!match) return { handled: false }
      const cmdName = match[1]!
      const cmdArgs = (match[2] ?? '').trim()
      const row = state.db.get<{ project_id: string | null }>(
        'SELECT project_id FROM sessions WHERE id = ?',
        sessionId,
      )
      if (!row) throw new Error(`Session ${sessionId} not found`)
      const { store, saved } = await loadStore(sessionId)
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
      const { tracker } = buildTrackerAndContext({
        store,
        saved,
        prepared,
        sessionId,
        projectId: row.project_id,
      })

      let bg = state.sessionBackgrounds.get(sessionId)
      if (!bg) {
        bg = createRuntimeBackgroundController({
          db: state.db,
          sessionId,
          runId: randomUUID(),
          wakeSession: state.options.wakeSession,
          location: prepared.location,
        })
        state.sessionBackgrounds.set(sessionId, bg)
      }

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
      })
      await prepared.ensureSessionStarted(extView)

      const handledNative = await runNativeRuntimeCommand({
        name: cmdName,
        args: cmdArgs,
        db: state.db,
        memoryActive: prepared.memoryActive,
        memoryStore: prepared.memoryStores.local,
        activeDreams: state.activeDreams,
        projectId: row.project_id,
        sessionId,
        resolvedModel: prepared.resolved
          ? {
              model: prepared.resolved.model,
              cost: prepared.resolved.info.cost,
            }
          : undefined,
        tracker,
        resolveEnv: prepared.resolveEnv,
        background: bg,
        setCacheEnabled: prepared.specialModel?.setCacheEnabled,
        signal: controller.signal,
        notify: (msg, level) =>
          emitNotify(sessionId, row.project_id, msg, level),
      })
      if (handledNative) return { handled: true }
      const handledExt = await prepared.extensionRunner.runCommand(
        extView,
        trimmed,
        controller.signal,
      )
      return { handled: handledExt }
    },
  }
}
