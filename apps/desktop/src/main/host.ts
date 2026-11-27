import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  connectLarkSetup,
  createRuntime,
  DaemonLarkHost,
  discoverLarkGroup,
  type LocalVelaRuntime,
  parseLarkChats,
} from '@glows777/vela/legacy-desktop'
import { BrowserWindow, clipboard, dialog, shell } from 'electron'
import {
  EVENT,
  type Event,
  type Message,
  type Project,
  type Request,
  type Session,
} from '../shared/bridge.ts'
import { wrapLarkAdapter } from './lark-adapter-bridge.ts'
import { larkStartupDiagnostic } from './lark-settings.ts'
import { saveModel } from './model-setup.ts'
import {
  DesktopClientIdTracker,
  extractMessageText,
  fetchLarkDesktopMessages,
  fetchLocalDesktopMessages,
  mapLocalRuntimeEvent,
  openLocalDesktopProject,
  resolveSessionOwnership,
  stopDesktopTarget,
  submitDesktopMessage,
  toDesktopMessage,
  toDesktopSession,
} from './runtime-bridge.ts'
import { handleDesktopRoutineRequest } from './runtime-routines.ts'
import {
  loadDesktopConfig,
  readSettings,
  withoutLocalOnlyOAuth,
} from './settings.ts'

const larkChatLink = (chatId: string) =>
  `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`

/** Owns the Runtime SDK in main. The renderer gets only the fixed preload contract. */
export async function openHost(
  config: ReturnType<typeof loadDesktopConfig>,
  loadLark: boolean,
  larkStartupError?: string,
) {
  const cwd = config.cwd
  const larkSettings = config.extensionConfig.lark ?? {}
  if (config.dataDir) {
    mkdirSync(config.dataDir, { recursive: true })
  }
  if (loadLark && larkSettings.chats !== undefined) {
    parseLarkChats(larkSettings.chats)
  }

  const fauxModel = process.env.VELA_MODEL?.startsWith('faux:')
    ? await (await import('@glows777/vela/testing')).loadFauxScenario(
        process.env.VELA_MODEL.slice(5),
      )
    : undefined
  const fixtureDir = process.env.VELA_DESKTOP_LARK_DIR
  const transport =
    loadLark && process.env.VELA_DESKTOP_LARK === 'fake'
      ? fixtureDir
        ? (await import('./testing/lark.ts')).fakeLark(fixtureDir)
        : (await import('./settings-transport.ts')).settingsTransport(
            larkSettings.appId,
            larkSettings.appSecret,
          )
      : undefined

  let larkHost: DaemonLarkHost | undefined
  let disposed = false
  const publish = (event: Event) => {
    if (disposed) return
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send(EVENT, event)
  }

  const configPath = join(config.agentDir, 'config.json')
  let cachedProviderSig = ''
  let cachedProviders = config.providers
  const getDesktopProviders = () => {
    try {
      const st = statSync(configPath)
      const sig = `${st.ino}:${st.mtimeMs}:${st.size}`
      if (sig !== cachedProviderSig) {
        cachedProviders = loadDesktopConfig(cwd, config.agentDir).providers
        cachedProviderSig = sig
      }
    } catch {
      cachedProviders = config.providers
    }
    return cachedProviders
  }

  const desktopCredentials = withoutLocalOnlyOAuth(
    getDesktopProviders,
    config.credentials,
  )

  const runtime = createRuntime({
    agentDir: config.agentDir,
    hostEnv: process.env,
    ...(fauxModel ? { defaultModel: fauxModel } : {}),
    credentials: desktopCredentials,
    logger: {
      debug() {},
      info() {},
      warn: (...args) => console.warn('[desktop-runtime]', ...args),
      error: (...args) => console.error('[desktop-runtime]', ...args),
    },
    getKnownChannelInfo: () =>
      larkHost?.knownChannelInfo() ?? { names: [], errors: new Map() },
  })

  const off: (() => void)[] = []
  const clientIdTracker = new DesktopClientIdTracker()
  const lastRunStatusBySession = new Map<string, string | null>()
  const retryTimersBySession = new Map<string, ReturnType<typeof setTimeout>>()

  const clearRetryTimer = (sessionId: string) => {
    const existing = retryTimersBySession.get(sessionId)
    if (existing) {
      clearTimeout(existing)
      retryTimersBySession.delete(sessionId)
    }
  }

  const resolveLastRunStatus = async (
    sessionId: string,
  ): Promise<string | null> => {
    if (lastRunStatusBySession.has(sessionId)) {
      return lastRunStatusBySession.get(sessionId) ?? null
    }
    let lastStatus: string | null = null
    let afterSeq: number | undefined
    while (true) {
      const page = await runtime.events
        .list({
          sessionId,
          ...(afterSeq !== undefined ? { afterSeq } : {}),
          limit: 200,
        })
        .catch(() => [])
      for (const evt of page) {
        if (evt.type === 'run_started') lastStatus = 'running'
        else if (evt.type === 'run_finished') lastStatus = evt.status
      }
      if (page.length < 200) break
      afterSeq = page.at(-1)?.seq
      if (afterSeq === undefined) break
    }
    lastRunStatusBySession.set(sessionId, lastStatus)
    return lastStatus
  }

  const getLarkContext = async () => {
    const bindings = await runtime.bindings.list({ channel: 'lark' })
    const larkProjectIds = new Set(
      bindings
        .map((b) => b.projectId)
        .filter((id): id is string => Boolean(id)),
    )
    return { bindings, larkProjectIds }
  }

  const buildDesktopSession = async (
    sessionId: string,
    bindings?: Awaited<ReturnType<LocalVelaRuntime['bindings']['list']>>,
    larkProjectIds?: ReadonlySet<string>,
  ): Promise<
    { session: Session; chatId: string; channel: 'local' | 'lark' } | undefined
  > => {
    const record = await runtime.sessions.get(sessionId)
    if (!record) return undefined
    const ctx =
      bindings && larkProjectIds
        ? { bindings, larkProjectIds }
        : await getLarkContext()
    const ownership = resolveSessionOwnership(
      record,
      ctx.bindings,
      ctx.larkProjectIds,
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
        : await resolveLastRunStatus(record.id)
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
    }
  }

  const directModel = Boolean(fauxModel)
  const settings = async () => {
    try {
      const available = await runtime.models({
        channel: 'local',
        env: process.env,
      })
      return readSettings({
        agentDir: config.agentDir,
        cwd,
        directModel,
        larkLoaded: loadLark,
        larkStartupError,
        hasAvailableModel: available.length > 0,
      })
    } catch {
      throw new Error(
        'Could not read desktop settings. Check the data directory, config.json and auth.json, then try again.',
      )
    }
  }

  try {
    await runtime.ready()

    if (loadLark) {
      const bridgedRuntime: LocalVelaRuntime = {
        ...runtime,
        registerChannel: (adapter) =>
          runtime.registerChannel(wrapLarkAdapter(adapter, runtime, publish)),
      }
      larkHost = new DaemonLarkHost(bridgedRuntime, {
        agentDir: config.agentDir,
        hostEnv: process.env,
        logger: console,
        ...(transport ? { transport } : {}),
      })
      await larkHost.sync(runtime.getLarkConfig(), true)
      const knownError = larkHost.knownChannelInfo().errors.get('lark')
      if (knownError && runtime.getLarkConfig().larkError) {
        throw new Error(knownError)
      }
    }

    await runtime.recover()

    const enabledChatIds = new Set(
      (await runtime.channels.chats('lark')).map((c) => c.chatId),
    )

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
                const rawMsg = event.message as {
                  role?: string
                  content?: unknown
                }
                const text = extractMessageText(rawMsg.content)
                let primaryClientId: string | undefined
                if (rawMsg.role === 'user') {
                  const matchedIds = clientIdTracker.consumeForUserMessage(
                    event.sessionId,
                    event.runId,
                    text,
                    event.messageId,
                  )
                  primaryClientId = matchedIds[0]
                  extraClientIds = matchedIds.slice(1)
                }
                mappedMsg = toDesktopMessage(
                  {
                    id: event.messageId,
                    sessionId: event.sessionId,
                    runId: event.runId,
                    kind: event.customType ? 'custom_message' : 'message',
                    role: rawMsg.role as Message['role'] | 'tool' | null,
                    text,
                    content: rawMsg.content,
                    display: event.display,
                    createdAt: event.timestamp,
                  },
                  primaryClientId,
                )
              }
              if (
                event.type === 'run_started' ||
                event.type === 'run_finished' ||
                event.type === 'tool_started' ||
                event.type === 'tool_finished' ||
                event.type === 'auto_retry_start' ||
                event.type === 'auto_retry_end' ||
                event.type === 'compaction_started' ||
                event.type === 'compaction_finished' ||
                event.type === 'compaction_failed'
              ) {
                clearRetryTimer(event.sessionId)
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
                      projectId: info.chatId,
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
                      projectId: info.chatId,
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

            // Lark session lifecycle & status events
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
                  chatId: info.chatId,
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
                  chatId: info.chatId,
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
                  chatId: info.chatId,
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
                  chatId: info.chatId,
                  rootId: info.session.topic?.rootId ?? info.session.sessionId,
                  sessionId: info.session.sessionId,
                  text: 'Retrying',
                },
              })
            }
          })
          .catch((error) =>
            console.error('[desktop-host] event bridge error:', error),
          )
      }),
    )

    const sessions = async (channel: string, chatId?: string) => {
      const { bindings, larkProjectIds } = await getLarkContext()
      const all = await runtime.sessions.list({ includeArchived: false })
      const out: Session[] = []
      for (const record of all) {
        const ownership = resolveSessionOwnership(
          record,
          bindings,
          larkProjectIds,
        )
        if (!ownership || ownership.channel !== channel) continue
        if (chatId && ownership.chatId !== chatId) continue
        const status = await runtime.sessions
          .status(record.id)
          .catch(() => undefined)
        const lastRunStatus =
          status?.activeRunId || record.state === 'running'
            ? 'running'
            : await resolveLastRunStatus(record.id)
        if (
          ownership.channel === 'lark' &&
          !ownership.topic &&
          !status?.activeRunId &&
          record.state === 'idle' &&
          lastRunStatus === null
        ) {
          continue
        }
        out.push(
          toDesktopSession(record, ownership, status, undefined, lastRunStatus),
        )
      }
      return out
    }

    const projects = async (): Promise<Project[]> => {
      const { bindings, larkProjectIds } = await getLarkContext()
      const allProjects = await runtime.projects.list({
        includeArchived: false,
      })
      const localProjects: Project[] = allProjects
        .filter(
          (p) =>
            !larkProjectIds.has(p.id) &&
            p.cwd !== null &&
            p.hubSessionId !== null,
        )
        .map((p) => ({
          id: p.id,
          channel: 'local' as const,
          cwd: p.cwd!,
          name: p.name,
          sessionId: p.hubSessionId!,
        }))
      if (!loadLark) return localProjects

      const adapterChats = await runtime.channels.chats('lark').catch(() => [])
      const projectsById = new Map(allProjects.map((p) => [p.id, p]))
      const rootBindingsByChat = new Map(
        bindings
          .filter((b) => b.kind === 'group' && !b.threadId)
          .map((b) => [b.externalId, b]),
      )
      const larkProjects: Project[] = []
      const seenChatIds = new Set<string>()
      for (const chat of adapterChats) {
        const root = rootBindingsByChat.get(chat.chatId)
        const project = root?.projectId
          ? projectsById.get(root.projectId)
          : undefined
        if (!project?.hubSessionId) continue
        seenChatIds.add(chat.chatId)
        larkProjects.push({
          id: chat.chatId,
          channel: 'lark',
          ...(chat.name ? { name: chat.name } : {}),
          sessionId: project.hubSessionId,
        })
      }
      for (const [chatId, root] of rootBindingsByChat) {
        if (seenChatIds.has(chatId) || !root.enabled || !root.projectId)
          continue
        const project = projectsById.get(root.projectId)
        if (!project?.hubSessionId) continue
        larkProjects.push({
          id: chatId,
          channel: 'lark',
          sessionId: project.hubSessionId,
        })
      }
      return [...localProjects, ...larkProjects]
    }

    const connectionState = async (channel: string) => {
      if (channel === 'local') return { connected: true }
      if (channel === 'lark') {
        if (!loadLark) return { connected: false }
        const statuses = await runtime.channels.list()
        const larkStatus = statuses.find((s) => s.name === 'lark')
        return {
          connected: larkStatus?.connected ?? false,
          ...(larkStatus?.error ? { error: larkStatus.error } : {}),
        }
      }
      throw new Error(`Unknown channel: ${channel}`)
    }

    const handle = async (
      request: Exclude<Request, { method: 'saveLark' }>,
    ) => {
      switch (request.method) {
        case 'channels':
          return [
            { name: 'local', description: 'Local desktop projects' },
            ...(loadLark
              ? [{ name: 'lark', description: 'Feishu / Lark' }]
              : []),
          ]
        case 'settings':
          return settings()
        case 'saveModel': {
          await saveModel({
            agentDir: config.agentDir,
            input: request.input,
            env: process.env,
          })
          await runtime.reloadConfig()
          return settings()
        }
        case 'sessions':
          return sessions(request.channel, request.chatId)
        case 'connection':
          return connectionState(request.channel)
        case 'submit':
          return submitDesktopMessage(
            runtime,
            loadLark,
            clientIdTracker,
            request,
          )
        case 'stop':
          return stopDesktopTarget(runtime, request)
        case 'projects':
          return projects()
        case 'openProject': {
          const { larkProjectIds } = await getLarkContext()
          return openLocalDesktopProject(runtime, request.input, larkProjectIds)
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
          return fetchLocalDesktopMessages(
            runtime,
            request.input,
            clientIdTracker,
          )
        case 'larkMessages':
          if (!loadLark) throw new Error('Lark is not available in this app')
          return fetchLarkDesktopMessages(runtime, request.input)
        case 'openMessageLink': {
          const url =
            typeof request.url === 'string' && URL.canParse(request.url)
              ? new URL(request.url)
              : undefined
          if (url?.protocol !== 'https:' && url?.protocol !== 'http:')
            throw new Error('Only HTTP and HTTPS links can be opened')
          await shell.openExternal(url.href)
          return
        }
        case 'copyMessageCode':
          if (typeof request.text !== 'string')
            throw new Error('Code to copy must be text')
          clipboard.writeText(request.text)
          return
        case 'openLarkChat': {
          if (!loadLark) throw new Error('Lark is not available in this app')
          const chats = await runtime.channels.chats('lark')
          if (!chats.some((chat) => chat.chatId === request.chatId))
            throw new Error('Open a Lark group that is enabled in this app')
          await shell.openExternal(larkChatLink(request.chatId))
          return
        }
        case 'listRoutines':
        case 'createRoutine':
        case 'editRoutine':
        case 'cancelRoutine':
          return handleDesktopRoutineRequest(runtime, larkSettings, request)
        default:
          throw new Error('Unknown desktop request')
      }
    }

    return {
      settings,
      handle,
      groupSetup() {
        const { appId, appSecret } = larkSettings
        if (
          !loadLark ||
          larkSettings.runInApp === false ||
          typeof appId !== 'string' ||
          !appId ||
          typeof appSecret !== 'string' ||
          !appSecret
        )
          throw new Error(
            'Configure Lark to run in this app before adding a group.',
          )
        return {
          agentDir: config.agentDir,
          async discover(signal: AbortSignal) {
            if (transport) {
              const discoveryTransport = fixtureDir
                ? (await import('./testing/lark.ts')).fakeLark(
                    join(fixtureDir, 'discovery'),
                  )
                : transport
              try {
                return await discoverLarkGroup(
                  discoveryTransport,
                  signal,
                  enabledChatIds,
                )
              } finally {
                discoveryTransport.stop()
              }
            }
            try {
              const connection = await connectLarkSetup(
                appId,
                appSecret,
                signal,
              )
              try {
                return await connection.waitForMention(enabledChatIds)
              } finally {
                connection.stop()
              }
            } catch (error) {
              throw new Error(
                (error instanceof Error
                  ? error.message
                  : String(error)
                ).replaceAll(appSecret, '[redacted]'),
              )
            }
          },
        }
      },
      async checkIdle() {
        const all = await runtime.sessions.list({ includeArchived: false })
        for (const s of all) {
          const st = await runtime.sessions.status(s.id)
          if (st.activeRunId || st.runningJobs > 0 || s.state === 'running') {
            throw new Error(
              'A session is still running or queued. Wait for it to finish before changing Lark settings.',
            )
          }
        }
      },
      dispose: async () => {
        disposed = true
        clientIdTracker.clear()
        for (const timer of retryTimersBySession.values()) clearTimeout(timer)
        retryTimersBySession.clear()
        for (const stop of off) stop()
        await larkHost?.stop().catch(() => {})
        await runtime.dispose()
      },
    }
  } catch (error) {
    disposed = true
    clientIdTracker.clear()
    for (const timer of retryTimersBySession.values()) clearTimeout(timer)
    retryTimersBySession.clear()
    for (const stop of off) stop()
    await larkHost?.stop().catch(() => {})
    await runtime.dispose().catch(() => {})
    throw error
  }
}

/** Invalid Lark configuration must leave Settings and Local available across launches. */
export function openAvailableHost(
  config: ReturnType<typeof loadDesktopConfig>,
) {
  const loadLark =
    config.extensionConfig.lark?.runInApp !== false &&
    config.extensions.some(
      (extension) => extension.name === 'lark' && 'builtin' in extension,
    )
  const opening = openHost(config, loadLark)
  return loadLark
    ? opening.catch((cause) =>
        openHost(config, false, larkStartupDiagnostic(cause)),
      )
    : opening
}
