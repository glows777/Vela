import { randomUUID } from 'node:crypto'
import { CliSessionClient } from '../../packages/vela/src/cli/runtime-client.ts'
import {
  inspectSession,
  inspectVela,
} from '../../packages/vela/src/driver/diagnostics.ts'
import {
  type Vela as CoreVela,
  failureHint,
  type ThinkingLevel,
  type VelaSession,
} from '../../packages/vela/src/driver/index.ts'
import type { RuntimeSessionInspection } from '../../packages/vela/src/driver/runtime-types.ts'
import type {
  ProjectRecord,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeEventPayload,
  StreamDeltaEvent,
  StreamDeltaListener,
} from '../../packages/vela/src/runtime/index.ts'
import type { VelaRuntime } from '../../packages/vela/src/runtime-sdk-types.ts'
import { type Vela, velaInternals } from './compat-vela.ts'

/**
 * Bridges a legacy `createVela()` / `VelaSession` instance onto the v0.9 `VelaRuntime`
 * contract so transitional e2e tests (`commands.test.ts`, `tui.test.ts`, `error-kinds.test.ts`)
 * drive the real thin CLI / TUI / `CommandContext` implementations before S4c retires `createVela`.
 */
export function legacyVelaAsRuntime(velaInput: Vela | CoreVela): {
  runtime: VelaRuntime
  clientFor: (session: VelaSession) => CliSessionClient
} {
  const vela = velaInput as Vela
  let internal:
    | (ReturnType<typeof velaInternals> & {
        registrations?: {
          get: (p: string) => unknown
          set: (p: string, r: never) => void
          delete: (p: string) => boolean
        }
      })
    | undefined
  try {
    internal = velaInternals(vela) as ReturnType<typeof velaInternals> & {
      registrations?: {
        get: (p: string) => unknown
        set: (p: string, r: never) => void
        delete: (p: string) => boolean
      }
    }
  } catch {
    internal = undefined
  }
  const eventListeners = new Set<RuntimeEventListener>()
  const deltaListeners = new Set<StreamDeltaListener>()
  const activeRunIds = new Map<string, string>()
  const abortedSessions = new Set<string>()
  const firstFailure = new Map<
    string,
    { message: string; kind?: string; hint?: string }
  >()
  const bashRunning = new Set<string>()
  const pendingPromptIds = new Map<string, string[]>()
  const clients = new Map<string, CliSessionClient>()
  let seq = 1

  const emitEvent = (sessionId: string, payload: RuntimeEventPayload) => {
    const ev = {
      ...payload,
      seq: seq++,
      sessionId,
      projectId: null,
      timestamp: new Date().toISOString(),
    } as RuntimeEvent
    for (const listener of [...eventListeners]) listener(ev)
  }

  const emitDelta = (delta: StreamDeltaEvent) => {
    for (const listener of [...deltaListeners]) listener(delta)
  }

  vela.subscribe((ev, sessionId) => {
    const runId = activeRunIds.get(sessionId) ?? 'legacy-run'
    switch (ev.type) {
      case 'agent_start': {
        if (!activeRunIds.has(sessionId)) {
          const nextRunId = randomUUID()
          activeRunIds.set(sessionId, nextRunId)
          firstFailure.delete(sessionId)
          abortedSessions.delete(sessionId)
          const inboxEventIds = pendingPromptIds.get(sessionId)?.splice(0)
          emitEvent(sessionId, {
            type: 'run_started',
            runId: nextRunId,
            trigger: 'user',
            ...(inboxEventIds?.length ? { inboxEventIds } : {}),
          })
        }
        break
      }
      case 'message_start':
        if (ev.message.role === 'user') {
          emitEvent(sessionId, {
            type: 'message_committed',
            runId,
            messageId: randomUUID(),
            message: ev.message,
            ...(ev.custom
              ? {
                  customType: ev.custom.customType,
                  display: ev.custom.display,
                }
              : {}),
          })
        }
        break
      case 'message_update': {
        const inner = ev.assistantMessageEvent
        if (inner.type === 'text_delta' || inner.type === 'thinking_delta') {
          emitDelta({
            type: inner.type,
            sessionId,
            runId,
            contentIndex: inner.contentIndex,
            delta: inner.delta,
          })
        } else if (inner.type === 'toolcall_end') {
          emitDelta({
            type: 'toolcall_end',
            sessionId,
            runId,
            contentIndex: inner.contentIndex,
            toolCall: inner.toolCall,
          })
        }
        break
      }
      case 'message_end':
        if (ev.message.role === 'assistant') {
          emitEvent(sessionId, {
            type: 'message_committed',
            runId,
            messageId: randomUUID(),
            message: ev.message,
          })
        }
        break
      case 'tool_execution_start':
        emitEvent(sessionId, {
          type: 'tool_started',
          runId,
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          input: ev.args,
        })
        break
      case 'tool_execution_update':
        emitDelta({
          type: 'tool_output_delta',
          sessionId,
          runId,
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          delta:
            typeof ev.partialResult === 'string'
              ? ev.partialResult
              : JSON.stringify(ev.partialResult ?? ''),
        })
        break
      case 'tool_execution_end':
        emitEvent(sessionId, {
          type: 'tool_finished',
          runId,
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          isError: ev.isError,
          durationMs: ev.durationMs,
          details: ev.details,
          result: ev.result,
        })
        break
      case 'auto_retry_start':
        emitEvent(sessionId, {
          type: 'auto_retry_start',
          runId,
          attempt: ev.attempt,
          maxAttempts: ev.maxAttempts,
          delayMs: ev.delayMs,
          errorMessage: ev.errorMessage,
        })
        break
      case 'auto_retry_end':
        emitEvent(sessionId, {
          type: 'auto_retry_end',
          runId,
          attempt: ev.attempt,
          success: ev.success,
          finalError: ev.finalError,
        })
        break
      case 'compaction_start':
        emitEvent(sessionId, {
          type: 'compaction_started',
          runId,
          reason: ev.reason,
        })
        break
      case 'compaction_end':
        if (ev.result) {
          emitEvent(sessionId, {
            type: 'compaction_finished',
            runId,
            reason: ev.reason,
            tokensBefore: ev.result.tokensBefore,
            tokensAfter: ev.result.tokensAfter,
            messages: ev.result.messages,
          })
        } else if (ev.errorMessage) {
          emitEvent(sessionId, {
            type: 'compaction_failed',
            runId,
            reason: ev.reason,
            aborted: ev.aborted,
            willRetry: ev.willRetry,
            errorMessage: ev.errorMessage,
          })
        }
        break
      case 'notify':
        emitEvent(sessionId, {
          type: 'notify',
          runId,
          level: ev.level,
          message: ev.message,
        })
        break
      case 'agent_end':
        if (ev.reason === 'aborted') {
          abortedSessions.add(sessionId)
        } else if (ev.reason === 'error' && !firstFailure.has(sessionId)) {
          firstFailure.set(sessionId, {
            message:
              ev.error instanceof Error ? ev.error.message : String(ev.error),
            kind: ev.errorKind,
            hint: failureHint(ev.errorKind, ev.error),
          })
        }
        break
      case 'agent_settled': {
        const failure = firstFailure.get(sessionId)
        firstFailure.delete(sessionId)
        const wasAborted = abortedSessions.delete(sessionId)
        const s = vela.session(sessionId)
        emitEvent(sessionId, {
          type: 'run_finished',
          runId,
          status: failure
            ? 'failed'
            : wasAborted || s.signal?.aborted
              ? 'stopped'
              : 'completed',
          ...(failure
            ? {
                error: failure.message,
                errorKind: failure.kind as never,
                ...(failure.hint ? { errorHint: failure.hint } : {}),
              }
            : {}),
        })
        activeRunIds.delete(sessionId)
        break
      }
    }
  })

  const ensureRestored = async (session: VelaSession) => {
    if (session.getEntries().length === 0) {
      await session.resume().catch(() => {})
    }
  }

  const buildInspection = async (
    session: VelaSession,
    opts?: { previewPrompt?: boolean },
  ): Promise<RuntimeSessionInspection> => {
    await ensureRestored(session)
    const res = await session.resources()
    let modelInfo: RuntimeSessionInspection['modelInfo']
    let modelError: string | undefined
    try {
      modelInfo = session.modelInfo
    } catch (error) {
      modelError = error instanceof Error ? error.message : String(error)
    }
    const promptSnapshot = opts?.previewPrompt
      ? await inspectSession(vela, session, { previewExtensions: true })
      : undefined
    const vInfo = inspectVela(vela)
    return {
      sessionId: session.id,
      cwd: session.cwd,
      ...(session.name ? { name: session.name } : {}),
      ...(session.channel ? { channel: session.channel } : {}),
      ...(session.parentSession
        ? { parentSession: session.parentSession }
        : {}),
      persistence: session.persistence,
      ...(modelInfo ? { modelInfo } : {}),
      ...(modelError ? { modelError } : {}),
      thinkingLevel: session.thinkingLevel,
      availableThinkingLevels: session.availableThinkingLevels(),
      limits: session.limits,
      usage: session.usage,
      entries: session.getEntries(),
      branch: session.getBranch(),
      leafId: session.getLeafId(),
      allTools: session.registry
        .getAllTools()
        .map((t: { name: string }) => t.name),
      activeTools: session.getActiveTools(),
      commands: vela.commands(session.id).map((c) => ({
        name: c.name,
        description: c.description,
        source: 'extension' as const,
        extension: c.extension,
      })),
      extensions: vela.extensions(session.id).map((e) => ({
        name: e.name,
        tools: [...e.tools],
        providers: [],
        commands: [...e.commands],
      })),
      extensionErrors: [],
      hooks: {
        pre: [...vInfo.hooks.pre],
        post: [...vInfo.hooks.post],
      },
      runningJobs:
        session.registry.background
          ?.tasks()
          .filter(
            (t: { snapshot: { state: string } }) =>
              t.snapshot.state === 'running',
          ) ?? [],
      isRunning: session.isRunning,
      isBashRunning: session.isBashRunning || bashRunning.has(session.id),
      queuedSteering: [...session.queue.steering],
      resources: {
        trusted: true,
        contextFiles: res.contextFiles.map(
          (f: { path: string; content: string }) => ({ ...f }),
        ),
        skills: res.skills.map(
          (s: {
            name: string
            description: string
            filePath: string
            disableModelInvocation?: boolean
          }) => ({
            name: s.name,
            description: s.description,
            filePath: s.filePath,
            ...(s.disableModelInvocation
              ? { disableModelInvocation: true }
              : {}),
          }),
        ),
        promptTemplates: res.promptTemplates.map(
          (p: {
            name: string
            description: string
            argumentHint?: string
          }) => ({
            name: p.name,
            description: p.description,
            ...(p.argumentHint ? { argumentHint: p.argumentHint } : {}),
          }),
        ),
        ...(res.defaultTools ? { defaultTools: [...res.defaultTools] } : {}),
        ...(res.enabledModels ? { enabledModels: [...res.enabledModels] } : {}),
      },
      ...(promptSnapshot
        ? {
            promptSnapshot: {
              ...promptSnapshot,
              stages: [...promptSnapshot.stages],
            },
          }
        : {}),
    }
  }

  const legacyProjects = new Map<string, ProjectRecord>()

  const runtime: VelaRuntime = {
    agentDir: (vela as unknown as { agentDir?: string }).agentDir ?? '',
    ready: () => vela.ready(),
    extensionErrors: async () => [],
    reloadConfig: async () => {},
    projects: {
      list: async (opts?: { includeArchived?: boolean }) =>
        [...legacyProjects.values()].filter(
          (p) => opts?.includeArchived || !p.archived,
        ),
      get: async (id: string) => legacyProjects.get(id),
      getByCwd: async (cwd: string) =>
        [...legacyProjects.values()].find((p) => p.cwd === cwd && !p.archived),
      create: async (
        input: Parameters<VelaRuntime['projects']['create']>[0],
      ) => {
        const now = new Date().toISOString()
        const rec: ProjectRecord = {
          id: input.id ?? randomUUID(),
          name: input.name,
          cwd: input.cwd ?? null,
          dataDir: input.dataDir ?? null,
          hubSessionId: null,
          defaultDriver: input.defaultDriver ?? 'vela',
          defaultLocation: input.defaultLocation ?? null,
          defaultModel: input.defaultModel ?? null,
          defaultThinkingLevel: input.defaultThinkingLevel ?? null,
          defaultTools: input.defaultTools ? [...input.defaultTools] : null,
          config: input.config ?? null,
          archived: false,
          createdAt: now,
          updatedAt: now,
        }
        legacyProjects.set(rec.id, rec)
        return rec
      },
      update: async (
        id: string,
        patch: Parameters<VelaRuntime['projects']['update']>[1],
      ) => {
        const existing = legacyProjects.get(id)
        if (!existing) throw new Error(`Project ${id} not found`)
        const updated: ProjectRecord = {
          ...existing,
          ...patch,
          updatedAt: new Date().toISOString(),
        }
        legacyProjects.set(id, updated)
        return updated
      },
      remove: async (id: string) => legacyProjects.delete(id),
    },
    trust: {
      check: async () => true,
      approve: async () => {},
    },
    oauthRegistrations: {
      get: async (p: string) => internal?.registrations?.get(p),
      set: async (p: string, r: never) => {
        internal?.registrations?.set(p, r)
      },
      delete: async (p: string) => internal?.registrations?.delete(p) ?? false,
    },
    sessions: {
      list: async () => [],
      listSummaries: async () => vela.listSessions(),
      get: async (id: string) => {
        const open = vela.sessions().find((x) => x.id === id)
        if (!open) {
          const probe = vela.session(id)
          let exists = false
          try {
            exists = (await probe.resume()) || probe.getEntries().length > 0
          } finally {
            await probe.close().catch(() => {})
          }
          if (!exists) return undefined
        }
        return {
          id,
          projectId: null,
          kind: 'chat',
          driver: 'vela',
          name: null,
          model: null,
          thinkingLevel: null,
          state: 'idle',
          location: { environment: 'local', cwd: vela.cwd },
          createdAt: '',
          updatedAt: '',
        } as never
      },
      create: async (input?: { id?: string; location?: { cwd?: string } }) => {
        const s = vela.session(input?.id, {
          ...(input?.location?.cwd ? { cwd: input.location.cwd } : {}),
        })
        return { id: s.id } as never
      },
      rename: async (id: string, name: string | null) => {
        const s = vela.session(id)
        s.setName(name ?? undefined)
        await s.save()
        return { id, name } as never
      },
      delete: async () => true,
      reset: async (id: string) => ({ id }) as never,
      status: async (id: string) => {
        const s = vela.session(id)
        const activeRunId = activeRunIds.get(id) ?? null
        return {
          session: {
            id,
            projectId: null,
            kind: 'chat',
            driver: 'vela',
            name: s.name ?? null,
            model: s.modelInfo?.ref ?? null,
            thinkingLevel: s.thinkingLevel,
            state: s.isRunning ? 'running' : 'idle',
            location: { environment: 'local', cwd: s.cwd },
            createdAt: '',
            updatedAt: '',
          },
          activeRunId,
          pendingInboxCount: 0,
          pendingApprovalCount: 0,
        } as never
      },
      messages: async () => ({ messages: [], hasMore: false }),
      configure: async () => {},
      setModel: async (id: string, ref: string) => {
        const s = vela.session(id)
        s.setModel(ref)
        return s.modelInfo
      },
      setThinkingLevel: async (id: string, level: ThinkingLevel) => {
        const s = vela.session(id)
        s.setThinkingLevel(level)
        return s.thinkingLevel
      },
      compact: (id: string, instructions?: string) =>
        vela.session(id).compact(instructions),
      tree: async (id: string) => {
        const s = vela.session(id)
        await ensureRestored(s)
        return {
          tree: s.getTree(),
          branch: s.getBranch(),
          entries: s.getEntries(),
          leafId: s.getLeafId(),
        }
      },
      navigateTree: async (id: string, targetId: string, opts?: never) => {
        const s = vela.session(id)
        const res = await s.navigateTree(targetId, opts)
        return { ...res, branch: s.getBranch() }
      },
      setLabel: async (
        id: string,
        entryId: string,
        label: string | undefined,
      ) => {
        const s = vela.session(id)
        s.setLabel(entryId, label)
        await s.save()
      },
      fork: async (id: string, entryId: string, opts?: never) => {
        const res = await vela.session(id).fork(entryId, opts)
        return {
          cancelled: res.cancelled,
          sessionId: res.session?.id,
          selectedText: res.selectedText,
        }
      },
      clone: async (id: string, opts?: never) => {
        const res = await vela.session(id).clone(opts)
        return {
          cancelled: res.cancelled,
          sessionId: res.session?.id,
          selectedText: res.selectedText,
        }
      },
      inspect: async (id: string, opts?: { previewPrompt?: boolean }) => {
        const wasOpen = vela.sessions().some((x) => x.id === id)
        const s = vela.session(id)
        try {
          return await buildInspection(s, opts)
        } finally {
          if (!wasOpen) await s.close().catch(() => {})
        }
      },
      execBash: async (
        id: string,
        command: string,
        opts?: { excludeFromContext?: boolean; id?: string },
      ) => {
        bashRunning.add(id)
        try {
          return await vela.session(id).executeBash(command, {
            excludeFromContext: opts?.excludeFromContext,
            onUpdate: (output) => {
              if (opts?.id) {
                emitDelta({
                  type: 'bash_output_delta',
                  sessionId: id,
                  bashId: opts.id,
                  delta: output,
                })
              }
            },
          })
        } finally {
          bashRunning.delete(id)
        }
      },
      abortBash: async (id: string) => {
        vela.session(id).abortBash()
      },
      runCommand: async (id: string, input: string) => {
        if (input === '/cache on' || input === '/cache off') {
          const maybe = vela.model as { setCacheEnabled?: (v: boolean) => void }
          if (typeof maybe?.setCacheEnabled === 'function') {
            maybe.setCacheEnabled(input === '/cache on')
            emitEvent(id, {
              type: 'notify',
              runId: 'cmd',
              level: 'info',
              message:
                input === '/cache on'
                  ? 'Cache simulation on'
                  : 'Cache simulation off',
            } as RuntimeEventPayload)
            return { handled: true }
          }
          return { handled: false }
        }
        const s = vela.session(id)
        await ensureRestored(s)
        const name = input.trim().slice(1).split(/\s/, 1)[0]
        const hasExtCmd = vela.commands(id).some((c) => c.name === name)
        if (!hasExtCmd) return { handled: false }
        await s.prompt(input, { source: 'interactive' })
        return { handled: true }
      },
      clearQueue: async (id: string) => vela.session(id).clearQueue(),
      export: async (
        id: string,
        format: 'jsonl' | 'html',
        outputPath?: string,
      ) =>
        format === 'jsonl'
          ? vela.session(id).exportJsonl(outputPath)
          : vela.session(id).exportHtml(outputPath),
    },
    prompt: async (id: string, input: { text: string }) => {
      const s = vela.session(id)
      const eventId = randomUUID()
      const pending = pendingPromptIds.get(id) ?? []
      pending.push(eventId)
      pendingPromptIds.set(id, pending)
      const resumeAndPrompt = async () => {
        await ensureRestored(s)
        await s.prompt(input.text, { source: 'interactive' })
      }
      const p =
        s.getEntries().length === 0
          ? resumeAndPrompt()
          : s.prompt(input.text, { source: 'interactive' })
      void p.catch(() => {})
      return { eventId, inserted: true }
    },
    steer: async (id: string, text: string) => {
      vela.session(id).steer(text)
    },
    stop: async (id: string) => {
      await vela.session(id).abort()
      return true
    },
    waitForIdle: async (id?: string) => {
      if (id) {
        const s = vela.session(id)
        await s.waitForIdle()
        await s.backgroundWork.settle(() => s.waitForIdle())
      }
    },
    jobs: {
      list: async (id?: string) =>
        id ? (vela.session(id).registry.background?.tasks() ?? []) : [],
      stop: async (id: string, jobId: string) =>
        vela.session(id).registry.background!.stop(jobId),
      promoteForeground: (id: string) => vela.session(id).backgroundTasks(),
    },
    approvals: { list: async () => [], resolve: async () => ({}) as never },
    timers: {
      list: async () => [],
      createRoutine: async () => ({}) as never,
      createFollowup: async () => ({}) as never,
      update: async () => undefined,
      delete: async () => false,
    },
    subscriptions: {
      list: async () => [],
      create: async () => ({}) as never,
      remove: async () => false,
    },
    bindings: {
      list: async () => [],
      get: async () => undefined,
      upsert: async () => ({}) as never,
      setEnabled: async () => undefined,
      remove: async () => false,
    },
    channels: {
      list: async () => [],
      setEnabled: async () => {
        throw new Error(
          'channels.setEnabled is not supported in legacy test runtime',
        )
      },
      chats: async () => [],
      submit: async () => ({
        outcome: 'not-sent' as const,
        error: 'channels.submit is not supported in legacy test runtime',
      }),
      subscribe: () => () => {},
    },
    blobs: {
      get: async () => undefined,
      list: async () => [],
      read: async () => new Uint8Array(),
      storeInbound: async () => ({}) as never,
    },
    events: {
      list: async () => [],
      bufferedDeltas: async () => [],
      subscribe: (listener: RuntimeEventListener) => {
        eventListeners.add(listener)
        return () => eventListeners.delete(listener)
      },
      subscribeDeltas: (listener: StreamDeltaListener) => {
        deltaListeners.add(listener)
        return () => deltaListeners.delete(listener)
      },
    },
    models: async (opts?: { all?: boolean; channel?: string }) =>
      vela.models(opts),
    loginProviders: async () => vela.loginProviders(),
    login: (p: string, m: 'oauth' | 'api_key', i: never, o?: never) =>
      vela.login(p, m, i, o),
    logout: (p: string, o?: never) => vela.logout(p, o),
    recover: async () => ({
      interruptedJobs: [],
      recoveredRuns: [],
      requeuedInboxRuns: [],
      wokenSessions: [],
    }),
    dispose: () => vela.dispose(),
  } as unknown as VelaRuntime

  return {
    runtime,
    clientFor: (session: VelaSession) => {
      let existing = clients.get(session.id)
      if (!existing) {
        existing = new CliSessionClient(runtime, session.id)
        clients.set(session.id, existing)
      }
      return existing
    },
  }
}
