import type {
  ProjectRecord,
  RuntimeSettingsState,
  SessionRecord,
  VelaRuntime,
} from '@glows777/vela'
import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import {
  EVENT,
  type Event,
  type LocalProject,
  type Message,
  type Project,
  REQUEST,
  type Request,
  type SettingsState,
} from '../shared/bridge.ts'
import { loadPreferences, savePreferences } from './preferences.ts'
import {
  createDesktopSession,
  DesktopClientIdTracker,
  deleteDesktopSession,
  extractMessageText,
  fetchDesktopMessages,
  getLarkProjectIds,
  mapLocalRuntimeEvent,
  openLocalDesktopProject,
  removeDesktopProject,
  renameDesktopSession,
  resolveSessionOwnership,
  stopDesktopTarget,
  submitDesktopMessage,
  toDesktopMessage,
  toDesktopSession,
} from './runtime-bridge.ts'
import {
  createManagedDaemonClient,
  isDisconnectError,
  MUTATING_REQUEST_METHODS,
  safeUserDataDir,
} from './runtime-connection.ts'
import { fetchLastRunStatus } from './runtime-history.ts'
import { handleDesktopRoutineRequest } from './runtime-routines.ts'

const larkChatLink = (chatId: string) =>
  `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`

export interface DesktopHostController {
  dispose(): Promise<void>
  beforeQuit(): Promise<boolean>
}

export async function startHost(): Promise<DesktopHostController> {
  const clientIdTracker = new DesktopClientIdTracker()
  const lastRunStatusBySession = new Map<string, string>()
  const retryTimersBySession = new Map<string, ReturnType<typeof setTimeout>>()
  let pendingLarkDiscovery: { chatId: string; name?: string } | undefined
  let disposed = false
  let eventChain = Promise.resolve()

  const publish = (event: Event) => {
    if (disposed) return
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(EVENT, event)
    }
  }

  const clearTimersAndCache = () => {
    lastRunStatusBySession.clear()
    for (const timer of retryTimersBySession.values()) {
      clearTimeout(timer)
    }
    retryTimersBySession.clear()
  }

  const conn = await createManagedDaemonClient(publish, clearTimersAndCache)
  const userDataDir = safeUserDataDir(conn.agentDir)

  const withPreferences = (state: RuntimeSettingsState): SettingsState => ({
    ...state,
    stopDaemonOnQuit: loadPreferences(userDataDir).stopDaemonOnQuit,
  })

  const getLarkContext = async (rt: VelaRuntime = conn.runtime()) => {
    const [bindings, allProjects] = await Promise.all([
      rt.bindings.list({ channel: 'lark' }),
      rt.projects.list({ includeArchived: true }),
    ])
    const projectsById = new Map<string, ProjectRecord>(
      allProjects.map((p) => [p.id, p]),
    )
    const larkProjectIds = getLarkProjectIds(bindings)
    return { bindings, projectsById, larkProjectIds }
  }

  const buildDesktopSession = async (
    recordOrId: SessionRecord | string,
    context?: Awaited<ReturnType<typeof getLarkContext>>,
    rt: VelaRuntime = conn.runtime(),
  ) => {
    const record =
      typeof recordOrId === 'string'
        ? await rt.sessions.get(recordOrId)
        : recordOrId
    if (!record || record.archived) return undefined
    const ctx = context ?? (await getLarkContext(rt))
    const ownership = resolveSessionOwnership(
      record,
      ctx.bindings,
      ctx.larkProjectIds,
      ctx.projectsById,
    )
    if (!ownership) return undefined
    const status = await rt.sessions.status(record.id).catch(() => undefined)
    let fallbackTask: string | undefined
    if (ownership.topic && !record.name?.trim()) {
      const firstPage = await rt.sessions
        .messages({ sessionId: record.id, limit: 1 })
        .catch(() => undefined)
      fallbackTask = firstPage?.messages[0]?.text.trim() || undefined
    }
    const lastRunStatus =
      status?.activeRunId || record.state === 'running'
        ? 'running'
        : await fetchLastRunStatus(rt, lastRunStatusBySession, record.id)
    return {
      session: toDesktopSession(
        record,
        ownership,
        status,
        fallbackTask,
        lastRunStatus,
      ),
      chatId: ownership.chatId,
      channel: ownership.channel,
      isUnusedLarkHub:
        ownership.channel === 'lark' &&
        !ownership.topic &&
        !status?.activeRunId &&
        record.state === 'idle' &&
        !lastRunStatus,
    }
  }

  try {
    const bindSubscriptions = (rt: VelaRuntime): (() => void) => {
      const subs: (() => void)[] = []
      subs.push(
        rt.events.subscribe((event) => {
          if (event.type === 'run_started') {
            lastRunStatusBySession.set(event.sessionId, 'running')
            clientIdTracker.onRunStarted(event.runId, event.inboxEventIds)
          } else if (event.type === 'run_finished') {
            lastRunStatusBySession.set(event.sessionId, event.status)
          } else if (event.type === 'session_reset') {
            lastRunStatusBySession.delete(event.sessionId)
          }
          eventChain = eventChain
            .then(async () => {
              if (disposed || conn.runtime() !== rt) return
              const info = await buildDesktopSession(
                event.sessionId,
                undefined,
                rt,
              )
              if (!info) return
              if (info.channel === 'local') {
                let mappedMsg: Message | undefined
                let extraClientIds: string[] = []
                if (event.type === 'message_committed') {
                  const msgText = extractMessageText(event.message.content)
                  const rawRole = event.message.role
                  const msgRole =
                    rawRole === 'user' ||
                    rawRole === 'assistant' ||
                    rawRole === 'tool' ||
                    rawRole === 'system'
                      ? rawRole
                      : null
                  const baseMsg = {
                    id: event.messageId,
                    sessionId: event.sessionId,
                    runId: event.runId,
                    kind: event.customType ? 'custom_message' : 'message',
                    role: msgRole,
                    text: msgText,
                    content: event.message.content,
                    display: event.display,
                    createdAt: event.timestamp,
                  }
                  const visiblePreview = toDesktopMessage(baseMsg)
                  if (visiblePreview) {
                    const consumed =
                      visiblePreview.role === 'user'
                        ? clientIdTracker.consumeForUserMessage(
                            event.sessionId,
                            event.runId,
                            msgText,
                            event.messageId,
                          )
                        : []
                    const [firstId, ...restIds] = consumed
                    extraClientIds = restIds
                    mappedMsg = firstId
                      ? { ...visiblePreview, clientMessageId: firstId }
                      : visiblePreview
                  }
                }
                if (
                  event.type === 'run_started' ||
                  event.type === 'tool_started' ||
                  event.type === 'auto_retry_end'
                ) {
                  const pendingTimer = retryTimersBySession.get(event.sessionId)
                  if (pendingTimer) {
                    clearTimeout(pendingTimer)
                    retryTimersBySession.delete(event.sessionId)
                  }
                }
                for (const desktopEvent of mapLocalRuntimeEvent(
                  event,
                  info.chatId,
                  info.session,
                  mappedMsg,
                )) {
                  publish(desktopEvent)
                }
                if (mappedMsg && extraClientIds.length > 0) {
                  extraClientIds.forEach((extraId, idx) => {
                    publish({
                      type: 'local',
                      channel: 'local',
                      value: {
                        version: 1,
                        id: `evt-${event.seq}-batch-${idx + 1}`,
                        time: event.timestamp,
                        ...(info.chatId ? { projectId: info.chatId } : {}),
                        sessionId: event.sessionId,
                        ...(event.type === 'message_committed' && event.runId
                          ? { runId: event.runId }
                          : {}),
                        type: 'message',
                        data: { ...mappedMsg!, clientMessageId: extraId },
                      },
                    })
                  })
                }
                if (event.type === 'run_finished') {
                  clientIdTracker.onRunFinished(event.runId)
                }
                if (event.type === 'auto_retry_start') {
                  const timer = setTimeout(() => {
                    if (retryTimersBySession.get(event.sessionId) !== timer) {
                      return
                    }
                    retryTimersBySession.delete(event.sessionId)
                    if (disposed) return
                    publish({
                      type: 'local',
                      channel: 'local',
                      value: {
                        version: 1,
                        id: `evt-${event.seq}-retry-end`,
                        time: new Date().toISOString(),
                        ...(info.chatId ? { projectId: info.chatId } : {}),
                        sessionId: event.sessionId,
                        ...(event.runId ? { runId: event.runId } : {}),
                        type: 'progress',
                        data: { stage: 'retry', state: 'finished' },
                      },
                    })
                  }, event.delayMs)
                  timer.unref?.()
                  retryTimersBySession.set(event.sessionId, timer)
                }
                return
              }

              if (event.type === 'run_started') {
                publish({
                  type: 'session',
                  channel: 'lark',
                  value: {
                    session: info.session,
                    run: { type: 'started', runId: event.runId },
                  },
                })
              } else if (event.type === 'run_finished') {
                const outcome =
                  event.status === 'failed' || event.status === 'interrupted'
                    ? 'failed'
                    : event.status === 'stopped'
                      ? 'stopped'
                      : event.silent
                        ? 'silent'
                        : 'done'
                publish({
                  type: 'session',
                  channel: 'lark',
                  value: {
                    session: info.session,
                    run: { type: 'finished', runId: event.runId, outcome },
                  },
                })
                publish({
                  type: 'status',
                  channel: 'lark',
                  value: {
                    chatId: info.chatId ?? '',
                    rootId:
                      info.session.topic?.rootId ?? info.session.sessionId,
                    sessionId: info.session.sessionId,
                    text: '',
                  },
                })
              } else if (event.type === 'tool_started') {
                publish({
                  type: 'status',
                  channel: 'lark',
                  value: {
                    chatId: info.chatId ?? '',
                    rootId:
                      info.session.topic?.rootId ?? info.session.sessionId,
                    sessionId: info.session.sessionId,
                    text: event.toolName,
                  },
                })
              } else if (
                event.type === 'tool_finished' ||
                event.type === 'auto_retry_end'
              ) {
                publish({
                  type: 'status',
                  channel: 'lark',
                  value: {
                    chatId: info.chatId ?? '',
                    rootId:
                      info.session.topic?.rootId ?? info.session.sessionId,
                    sessionId: info.session.sessionId,
                    text: '',
                  },
                })
              } else if (event.type === 'auto_retry_start') {
                publish({
                  type: 'status',
                  channel: 'lark',
                  value: {
                    chatId: info.chatId ?? '',
                    rootId:
                      info.session.topic?.rootId ?? info.session.sessionId,
                    sessionId: info.session.sessionId,
                    text: 'Retrying after a transient error',
                  },
                })
              }
            })
            .catch(() => {})
        }),
      )

      subs.push(
        rt.channels.subscribe((event) => {
          if (event.type === 'channel_status') {
            publish({
              type: 'connection',
              channel: event.channel,
              value: {
                connected: event.connected,
                ...(event.error ? { error: event.error } : {}),
              },
            })
            publish({
              type: 'channel',
              channel: event.channel,
              value: {
                type: 'channel_status',
                connected: event.connected,
                ...(event.error ? { error: event.error } : {}),
                ...(event.reset ? { reset: true } : {}),
              },
            })
            return
          }
          if (event.type === 'channel_history_changed') {
            publish({
              type: 'channel',
              channel: event.channel,
              value: {
                type: 'channel_history_changed',
                ...(event.chatId ? { chatId: event.chatId } : {}),
                ...(event.sessionId ? { sessionId: event.sessionId } : {}),
              },
            })
          }
        }),
      )

      return () => {
        for (const unsub of subs.splice(0)) {
          unsub()
        }
      }
    }

    conn.setSubscriptionBinder(bindSubscriptions)

    const isLarkEnabled = async (rt: VelaRuntime): Promise<boolean> => {
      try {
        const state = await rt.settings.get()
        return state.lark.enabled
      } catch {
        const statuses = await rt.channels.list().catch(() => [])
        const lark = statuses.find((s) => s.name === 'lark')
        return lark ? lark.enabled : true
      }
    }

    const sessionsFor = async (
      rt: VelaRuntime,
      channel: string,
      chatId?: string,
    ) => {
      const ctx = await getLarkContext(rt)
      if (channel === 'lark') {
        if (!(await isLarkEnabled(rt))) return []
        const all = await rt.sessions.list({ includeArchived: false })
        const matching = all.filter((record) => {
          const ownership = resolveSessionOwnership(
            record,
            ctx.bindings,
            ctx.larkProjectIds,
            ctx.projectsById,
          )
          return (
            ownership?.channel === 'lark' &&
            (!chatId || ownership.chatId === chatId)
          )
        })
        const built = await Promise.all(
          matching.map((record) => buildDesktopSession(record, ctx, rt)),
        )
        return built
          .filter(
            (
              entry,
            ): entry is NonNullable<
              Awaited<ReturnType<typeof buildDesktopSession>>
            > => Boolean(entry && !entry.isUnusedLarkHub),
          )
          .map((entry) => entry.session)
      }
      if (channel === 'local') {
        const all = await rt.sessions.list({ includeArchived: false })
        const matching = all.filter((record) => {
          const ownership = resolveSessionOwnership(
            record,
            ctx.bindings,
            ctx.larkProjectIds,
            ctx.projectsById,
          )
          if (ownership?.channel !== 'local') return false
          if (!chatId) return true
          return chatId === 'quick'
            ? ownership.chatKind === 'quick'
            : ownership.chatId === chatId
        })
        const built = await Promise.all(
          matching.map((record) => buildDesktopSession(record, ctx, rt)),
        )
        return built
          .filter(
            (
              entry,
            ): entry is NonNullable<
              Awaited<ReturnType<typeof buildDesktopSession>>
            > => Boolean(entry),
          )
          .map((entry) => entry.session)
      }
      throw new Error(`Unknown channel: ${channel}`)
    }

    const listProjects = async (rt: VelaRuntime): Promise<Project[]> => {
      const ctx = await getLarkContext(rt)
      const allProjects = await rt.projects.list({
        includeArchived: false,
      })
      const localProjects: LocalProject[] = []
      for (const p of allProjects) {
        if (ctx.larkProjectIds.has(p.id)) continue
        const effectiveLocation =
          p.defaultLocation ??
          (p.cwd ? { environment: 'local', cwd: p.cwd } : undefined)
        const effectiveCwd = effectiveLocation?.cwd
        if (!effectiveCwd) continue
        localProjects.push({
          id: p.id,
          channel: 'local' as const,
          cwd: effectiveCwd,
          ...(effectiveLocation ? { location: effectiveLocation } : {}),
          name: p.name,
        })
      }

      const larkEnabled = await isLarkEnabled(rt)
      const larkProjects: Project[] = []
      if (larkEnabled) {
        const adapterChats = await rt.channels.chats('lark').catch(() => [])
        const seenChatIds = new Set<string>()
        for (const root of ctx.bindings) {
          if (root.threadId || !root.enabled || !root.projectId) continue
          const project = ctx.projectsById.get(root.projectId)
          if (!project || project.archived) continue
          const sessionId = root.sessionId ?? project.hubSessionId
          if (!sessionId) continue
          seenChatIds.add(root.externalId)
          const chatMeta = adapterChats.find(
            (c) => c.chatId === root.externalId,
          )
          larkProjects.push({
            id: root.externalId,
            channel: 'lark',
            ...(chatMeta?.name ? { name: chatMeta.name } : {}),
            sessionId,
          })
        }
        for (const chat of adapterChats) {
          if (seenChatIds.has(chat.chatId)) continue
          const root = ctx.bindings.find(
            (b) => b.externalId === chat.chatId && !b.threadId && b.enabled,
          )
          if (!root?.projectId) continue
          const project = ctx.projectsById.get(root.projectId)
          const sessionId = root.sessionId ?? project?.hubSessionId
          if (!project || project.archived || !sessionId) continue
          larkProjects.push({
            id: chat.chatId,
            channel: 'lark',
            ...(chat.name ? { name: chat.name } : {}),
            sessionId,
          })
        }
      }
      return [...localProjects, ...larkProjects]
    }

    const connectionState = async (rt: VelaRuntime, channel: string) => {
      if (channel === 'local') {
        return conn.disconnected
          ? {
              connected: false,
              error: 'Background service disconnected. Reconnecting…',
            }
          : { connected: true }
      }
      if (channel === 'lark') {
        const statuses = await rt.channels.list().catch(() => [])
        const larkStatus = statuses.find((s) => s.name === 'lark')
        const state = await rt.settings.get().catch(() => undefined)
        const enabled = state
          ? state.lark.enabled
          : larkStatus?.enabled !== false
        if (!enabled) return { connected: false }
        const error = state?.lark.startupError ?? larkStatus?.error
        return {
          connected: larkStatus?.connected ?? false,
          ...(error ? { error } : {}),
        }
      }
      throw new Error(`Unknown channel: ${channel}`)
    }

    const executeRequest = async (rt: VelaRuntime, request: Request) => {
      switch (request.method) {
        case 'channels': {
          const state = await rt.settings.get().catch(() => undefined)
          const larkAvailable = state
            ? state.lark.enabled && !state.lark.startupError
            : await isLarkEnabled(rt)
          return [
            { name: 'local', description: 'Work on this computer' },
            ...(larkAvailable
              ? [{ name: 'lark', description: 'Feishu / Lark' }]
              : []),
          ]
        }
        case 'settings':
          return withPreferences(await rt.settings.get())
        case 'saveModel':
          return withPreferences(await rt.settings.saveModel(request.input))
        case 'saveLark': {
          if (
            ('enabled' in request.input && request.input.enabled === false) ||
            (!('enabled' in request.input) && !('removeChat' in request.input))
          ) {
            pendingLarkDiscovery = undefined
          }
          return withPreferences(await rt.settings.saveLark(request.input))
        }
        case 'savePreferences': {
          savePreferences(request.input, userDataDir)
          return withPreferences(await rt.settings.get())
        }
        case 'discoverLarkGroup': {
          const found = await rt.settings.discoverLarkGroup()
          pendingLarkDiscovery = found
          return found
        }
        case 'confirmLarkGroup': {
          if (!pendingLarkDiscovery?.chatId) {
            throw new Error('No pending group approval.')
          }
          const chatId = pendingLarkDiscovery.chatId
          pendingLarkDiscovery = undefined
          await rt.settings.confirmLarkGroup(chatId)
          return
        }
        case 'cancelLarkSetup':
          pendingLarkDiscovery = undefined
          return rt.settings.cancelLarkSetup()
        case 'sessions':
          return sessionsFor(rt, request.channel, request.chatId)
        case 'createSession':
          return createDesktopSession(rt, request.input)
        case 'renameSession':
          return renameDesktopSession(rt, request.input)
        case 'deleteSession': {
          const deleted = await deleteDesktopSession(rt, request.input)
          if (deleted) {
            publish({
              type: 'channel',
              channel: 'local',
              value: { type: 'channel_status', connected: true, reset: true },
            })
          }
          return deleted
        }
        case 'connection':
          return connectionState(rt, request.channel)
        case 'submit':
          return submitDesktopMessage(
            rt,
            await isLarkEnabled(rt),
            clientIdTracker,
            request,
          )
        case 'stop':
          return stopDesktopTarget(rt, request)
        case 'projects':
          return listProjects(rt)
        case 'openProject':
          return openLocalDesktopProject(rt, request.input)
        case 'removeProject': {
          const removed = await removeDesktopProject(rt, request.input)
          if (removed) {
            publish({
              type: 'channel',
              channel: 'local',
              value: { type: 'channel_status', connected: true, reset: true },
            })
          }
          return removed
        }
        case 'chooseFolder': {
          const owner =
            BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
          const result = owner
            ? await dialog.showOpenDialog(owner, {
                properties: ['openDirectory'],
              })
            : await dialog.showOpenDialog({ properties: ['openDirectory'] })
          return result.canceled ? undefined : result.filePaths[0]
        }
        case 'messages':
          return fetchDesktopMessages(rt, request.input, clientIdTracker)
        case 'openMessageLink': {
          const url =
            typeof request.url === 'string' && URL.canParse(request.url)
              ? new URL(request.url)
              : undefined
          if (url?.protocol !== 'https:' && url?.protocol !== 'http:') {
            throw new Error('Only HTTP and HTTPS links can be opened')
          }
          await shell.openExternal(url.href)
          return
        }
        case 'copyMessageCode':
          if (typeof request.text !== 'string') {
            throw new Error('Code to copy must be text')
          }
          clipboard.writeText(request.text)
          return
        case 'openLarkChat': {
          if (!(await isLarkEnabled(rt))) {
            throw new Error('Lark is not available in this app')
          }
          const chats = await rt.channels.chats('lark').catch(() => [])
          if (!chats.some((chat) => chat.chatId === request.chatId)) {
            throw new Error('Open a Lark group that is enabled in this app')
          }
          await shell.openExternal(larkChatLink(request.chatId))
          return
        }
        case 'listRoutines':
        case 'createRoutine':
        case 'editRoutine':
        case 'cancelRoutine':
          return handleDesktopRoutineRequest(rt, {}, request)
        default:
          throw new Error('Unknown desktop request')
      }
    }

    const handle = async (request: Request) => {
      const mutating = MUTATING_REQUEST_METHODS.has(request.method)
      if (conn.disconnected) {
        if (mutating) {
          void conn.reconnect().catch(() => {})
          throw new Error(
            'Background service disconnected and is reconnecting. Please try again.',
          )
        }
        await conn.reconnect()
      }
      try {
        return await executeRequest(conn.runtime(), request)
      } catch (error) {
        if (!isDisconnectError(error) || disposed) throw error
        if (mutating) {
          void conn.reconnect({ force: true }).catch(() => {})
          throw error
        }
        const recovered = await conn.reconnect({ force: true })
        return executeRequest(recovered, request)
      }
    }

    ipcMain.handle(REQUEST, (_event, request: Request) => handle(request))

    const dispose = async () => {
      if (disposed) return
      disposed = true
      ipcMain.removeHandler(REQUEST)
      clearTimersAndCache()
      await eventChain.catch(() => {})
      await conn.dispose()
    }

    const beforeQuit = async (): Promise<boolean> => {
      const prefs = loadPreferences(userDataDir)
      const quitOk = await conn.confirmAndStopBeforeQuit(prefs.stopDaemonOnQuit)
      if (quitOk) {
        disposed = true
        ipcMain.removeHandler(REQUEST)
        clearTimersAndCache()
        await eventChain.catch(() => {})
      }
      return quitOk
    }

    return { dispose, beforeQuit }
  } catch (error) {
    ipcMain.removeHandler(REQUEST)
    clearTimersAndCache()
    await conn.dispose()
    throw error
  }
}
