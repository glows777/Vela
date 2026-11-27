import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectRuntime,
  type ProjectRecord,
  type RuntimeSettingsState,
  stopDaemon,
  type VelaRuntime,
} from '@glows777/vela'
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
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
import { fetchLastRunStatus } from './runtime-history.ts'
import { handleDesktopRoutineRequest } from './runtime-routines.ts'

const larkChatLink = (chatId: string) =>
  `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`

function resolveDaemonEntry(): string {
  const mainDir = dirname(fileURLToPath(import.meta.url))
  const unpackedDir = mainDir.replace(
    /app\.asar(?=[\\/]|$)/,
    'app.asar.unpacked',
  )
  const unpackedCandidate = join(unpackedDir, 'daemon.mjs')
  if (existsSync(unpackedCandidate)) return unpackedCandidate
  return join(mainDir, 'daemon.mjs')
}

function buildDaemonEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ELECTRON_RUN_AS_NODE: '1',
  }
  const modelEnv = process.env.VELA_MODEL?.trim()
  if (modelEnv === 'mock' || modelEnv?.startsWith('faux:')) {
    env.VELA_MODEL = modelEnv
  }
  if (process.env.VELA_DESKTOP_LARK) {
    env.VELA_DESKTOP_LARK = process.env.VELA_DESKTOP_LARK
  }
  if (process.env.VELA_DESKTOP_LARK_DIR) {
    env.VELA_DESKTOP_LARK_DIR = process.env.VELA_DESKTOP_LARK_DIR
  }
  if (process.env.VELA_DESKTOP_VERIFY_DISCOVERY_TIMEOUT) {
    env.VELA_DESKTOP_VERIFY_DISCOVERY_TIMEOUT =
      process.env.VELA_DESKTOP_VERIFY_DISCOVERY_TIMEOUT
  }
  if (process.env.VELA_DIR) {
    env.VELA_DIR = process.env.VELA_DIR
  }
  return env
}

function resolveAgentDir(): string {
  const envDir = process.env.VELA_DIR?.trim()
  return envDir ? resolve(envDir) : join(homedir(), '.vela')
}

function safeUserDataDir(agentDir: string): string {
  try {
    return app.getPath('userData')
  } catch {
    return agentDir
  }
}

export interface DesktopHostController {
  dispose(): Promise<void>
  beforeQuit(): Promise<boolean>
}

export async function startHost(): Promise<DesktopHostController> {
  const agentDir = resolveAgentDir()
  const userDataDir = safeUserDataDir(agentDir)
  const daemonEntry = resolveDaemonEntry()
  const runtime: VelaRuntime = await connectRuntime({
    agentDir,
    hostEnv: process.env,
    daemonCommand: {
      command: process.execPath,
      args: [daemonEntry],
      env: buildDaemonEnv(),
    },
  })

  const off: (() => void)[] = []
  const clientIdTracker = new DesktopClientIdTracker()
  const lastRunStatusBySession = new Map<string, string>()
  const retryTimersBySession = new Map<string, ReturnType<typeof setTimeout>>()
  let pendingLarkDiscovery: { chatId: string; name?: string } | undefined
  let disposed = false

  const publish = (event: Event) => {
    if (disposed) return
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(EVENT, event)
    }
  }

  const withPreferences = (state: RuntimeSettingsState): SettingsState => ({
    ...state,
    stopDaemonOnQuit: loadPreferences(userDataDir).stopDaemonOnQuit,
  })

  const getLarkContext = async () => {
    const [bindings, allProjects] = await Promise.all([
      runtime.bindings.list({ channel: 'lark' }),
      runtime.projects.list({ includeArchived: true }),
    ])
    const projectsById = new Map<string, ProjectRecord>(
      allProjects.map((p) => [p.id, p]),
    )
    const larkProjectIds = getLarkProjectIds(bindings)
    return { bindings, projectsById, larkProjectIds }
  }

  const buildDesktopSession = async (
    sessionId: string,
    context?: Awaited<ReturnType<typeof getLarkContext>>,
  ) => {
    const record = await runtime.sessions.get(sessionId)
    if (!record || record.archived) return undefined
    const ctx = context ?? (await getLarkContext())
    const ownership = resolveSessionOwnership(
      record,
      ctx.bindings,
      ctx.larkProjectIds,
      ctx.projectsById,
    )
    if (!ownership) return undefined
    const status = await runtime.sessions
      .status(record.id)
      .catch(() => undefined)
    let fallbackTask: string | undefined
    if (ownership.topic && !record.name?.trim()) {
      const firstPage = await runtime.sessions
        .messages({ sessionId: record.id, limit: 1 })
        .catch(() => undefined)
      fallbackTask = firstPage?.messages[0]?.text.trim() || undefined
    }
    const lastRunStatus =
      status?.activeRunId || record.state === 'running'
        ? 'running'
        : await fetchLastRunStatus(runtime, lastRunStatusBySession, record.id)
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
    await runtime.ready()

    let eventChain = Promise.resolve()
    off.push(
      runtime.events.subscribe((event) => {
        if (event.type === 'run_started') {
          lastRunStatusBySession.set(event.sessionId, 'running')
          clientIdTracker.onRunStarted(event.runId, event.inboxEventIds)
        } else if (event.type === 'run_finished') {
          lastRunStatusBySession.set(event.sessionId, event.status)
        }
        eventChain = eventChain
          .then(async () => {
            if (disposed) return
            const info = await buildDesktopSession(event.sessionId)
            if (!info) return
            if (info.channel === 'local') {
              let mappedMsg: Message | undefined
              let extraClientIds: string[] = []
              if (event.type === 'message_committed') {
                const msgText = extractMessageText(event.message.content)
                const msgRole =
                  event.message.role === 'user' ||
                  event.message.role === 'assistant' ||
                  event.message.role === 'system'
                    ? event.message.role
                    : 'assistant'
                const isUser = msgRole === 'user'
                const consumed = isUser
                  ? clientIdTracker.consumeForUserMessage(
                      event.sessionId,
                      event.runId,
                      msgText,
                      event.messageId,
                    )
                  : []
                const [firstId, ...restIds] = consumed
                extraClientIds = restIds
                mappedMsg = toDesktopMessage(
                  {
                    id: event.messageId,
                    sessionId: event.sessionId,
                    runId: event.runId,
                    kind: 'message',
                    role: msgRole,
                    text: msgText,
                    content: event.message.content,
                    display: event.display,
                    createdAt: event.timestamp,
                  },
                  firstId,
                )
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
                  rootId: info.session.topic?.rootId ?? info.session.sessionId,
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
                  rootId: info.session.topic?.rootId ?? info.session.sessionId,
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
                  rootId: info.session.topic?.rootId ?? info.session.sessionId,
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
                  rootId: info.session.topic?.rootId ?? info.session.sessionId,
                  sessionId: info.session.sessionId,
                  text: 'Retrying after a transient error',
                },
              })
            }
          })
          .catch(() => {})
      }),
    )

    off.push(
      runtime.channels.subscribe((event) => {
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

    const isLarkEnabled = async (): Promise<boolean> => {
      try {
        const state = await runtime.settings.get()
        return state.lark.enabled
      } catch {
        const statuses = await runtime.channels.list().catch(() => [])
        const lark = statuses.find((s) => s.name === 'lark')
        return lark ? lark.enabled : true
      }
    }

    const sessionsFor = async (channel: string, chatId?: string) => {
      const ctx = await getLarkContext()
      if (channel === 'lark') {
        const enabled = await isLarkEnabled()
        if (!enabled) return []
        const all = await runtime.sessions.list({ includeArchived: false })
        const built = await Promise.all(
          all.map((record) => buildDesktopSession(record.id, ctx)),
        )
        return built
          .filter(
            (
              entry,
            ): entry is NonNullable<
              Awaited<ReturnType<typeof buildDesktopSession>>
            > =>
              Boolean(
                entry &&
                  entry.channel === 'lark' &&
                  !entry.isUnusedLarkHub &&
                  (!chatId || entry.chatId === chatId),
              ),
          )
          .map((entry) => entry.session)
      }
      if (channel === 'local') {
        const all = await runtime.sessions.list({ includeArchived: false })
        const built = await Promise.all(
          all.map((record) => buildDesktopSession(record.id, ctx)),
        )
        return built
          .filter(
            (
              entry,
            ): entry is NonNullable<
              Awaited<ReturnType<typeof buildDesktopSession>>
            > =>
              Boolean(
                entry &&
                  entry.channel === 'local' &&
                  (!chatId
                    ? true
                    : chatId === 'quick'
                      ? entry.session.chatKind === 'quick'
                      : entry.chatId === chatId),
              ),
          )
          .map((entry) => entry.session)
      }
      throw new Error(`Unknown channel: ${channel}`)
    }

    const listProjects = async (): Promise<Project[]> => {
      const ctx = await getLarkContext()
      const allProjects = await runtime.projects.list({
        includeArchived: false,
      })
      const localProjects: LocalProject[] = allProjects
        .filter((p) => !ctx.larkProjectIds.has(p.id))
        .map((p) => ({
          id: p.id,
          channel: 'local' as const,
          cwd: p.cwd ?? agentDir,
          name: p.name,
        }))

      const larkEnabled = await isLarkEnabled()
      const larkProjects: Project[] = []
      if (larkEnabled) {
        const adapterChats = await runtime.channels
          .chats('lark')
          .catch(() => [])
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

    const connectionState = async (channel: string) => {
      if (channel === 'local') return { connected: true }
      if (channel === 'lark') {
        const statuses = await runtime.channels.list().catch(() => [])
        const larkStatus = statuses.find((s) => s.name === 'lark')
        const state = await runtime.settings.get().catch(() => undefined)
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

    const handle = async (request: Request) => {
      switch (request.method) {
        case 'channels': {
          const state = await runtime.settings.get().catch(() => undefined)
          const larkAvailable = state
            ? state.lark.enabled && !state.lark.startupError
            : await isLarkEnabled()
          return [
            { name: 'local', description: 'Work on this computer' },
            ...(larkAvailable
              ? [{ name: 'lark', description: 'Feishu / Lark' }]
              : []),
          ]
        }
        case 'settings':
          return withPreferences(await runtime.settings.get())
        case 'saveModel':
          return withPreferences(
            await runtime.settings.saveModel(request.input),
          )
        case 'saveLark':
          return withPreferences(await runtime.settings.saveLark(request.input))
        case 'savePreferences': {
          savePreferences(request.input, userDataDir)
          return withPreferences(await runtime.settings.get())
        }
        case 'discoverLarkGroup': {
          const found = await runtime.settings.discoverLarkGroup()
          pendingLarkDiscovery = found
          return found
        }
        case 'confirmLarkGroup': {
          if (!pendingLarkDiscovery?.chatId) {
            throw new Error('No pending group approval.')
          }
          const chatId = pendingLarkDiscovery.chatId
          pendingLarkDiscovery = undefined
          await runtime.settings.confirmLarkGroup(chatId)
          return
        }
        case 'cancelLarkSetup':
          pendingLarkDiscovery = undefined
          return runtime.settings.cancelLarkSetup()
        case 'sessions':
          return sessionsFor(request.channel, request.chatId)
        case 'createSession':
          return createDesktopSession(runtime, request.input)
        case 'renameSession':
          return renameDesktopSession(runtime, request.input)
        case 'deleteSession': {
          const deleted = await deleteDesktopSession(runtime, request.input)
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
          return connectionState(request.channel)
        case 'submit':
          return submitDesktopMessage(
            runtime,
            await isLarkEnabled(),
            clientIdTracker,
            request,
          )
        case 'stop':
          return stopDesktopTarget(runtime, request)
        case 'projects':
          return listProjects()
        case 'openProject':
          return openLocalDesktopProject(runtime, request.input)
        case 'removeProject': {
          const removed = await removeDesktopProject(runtime, request.input)
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
          return fetchDesktopMessages(runtime, request.input, clientIdTracker)
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
          if (!(await isLarkEnabled())) {
            throw new Error('Lark is not available in this app')
          }
          const chats = await runtime.channels.chats('lark').catch(() => [])
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
          return handleDesktopRoutineRequest(runtime, {}, request)
        default:
          throw new Error('Unknown desktop request')
      }
    }

    ipcMain.handle(REQUEST, (_event, request: Request) => handle(request))

    const dispose = async () => {
      if (disposed) return
      disposed = true
      ipcMain.removeHandler(REQUEST)
      for (const timer of retryTimersBySession.values()) {
        clearTimeout(timer)
      }
      retryTimersBySession.clear()
      for (const unregister of off.splice(0)) {
        unregister()
      }
      await eventChain.catch(() => {})
      await runtime.dispose()
    }

    const beforeQuit = async (): Promise<boolean> => {
      const prefs = loadPreferences(userDataDir)
      if (!prefs.stopDaemonOnQuit) {
        await dispose()
        return true
      }
      let hasActiveWork = false
      try {
        const activeSessions = await runtime.sessions.list({
          includeArchived: false,
        })
        for (const s of activeSessions) {
          const st = await runtime.sessions.status(s.id).catch(() => undefined)
          if (st?.activeRunId || st?.runningJobs || s.state === 'running') {
            hasActiveWork = true
            break
          }
        }
      } catch {
        hasActiveWork = false
      }
      if (hasActiveWork) {
        const owner =
          BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
        const messageBoxOptions: Electron.MessageBoxOptions = {
          type: 'question',
          buttons: ['Stop and quit', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          message: 'A session or routine is still running.',
          detail: 'Stopping the background service will interrupt active work.',
        }
        const choice = owner
          ? await dialog.showMessageBox(owner, messageBoxOptions)
          : await dialog.showMessageBox(messageBoxOptions)
        if (choice.response !== 0) {
          return false
        }
      }
      await dispose()
      await stopDaemon({ agentDir, hostEnv: process.env }).catch(() => {})
      return true
    }

    return { dispose, beforeQuit }
  } catch (error) {
    ipcMain.removeHandler(REQUEST)
    for (const unregister of off.splice(0)) {
      unregister()
    }
    await runtime.dispose().catch(() => {})
    throw error
  }
}
