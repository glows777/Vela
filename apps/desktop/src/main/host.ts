import type { IncomingMessage } from '@glows777/vela-channels'
import {
  channelSessionId,
  createChannelVela,
  local,
} from '@glows777/vela-channels'
import { resolveShellPath } from '@glows777/vela-core'
import { type LarkHost, LarkSubmitError, lark } from '@glows777/vela-lark'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import {
  EVENT,
  type Event,
  type LarkSubmit,
  REQUEST,
  type Request,
} from '../shared/bridge.ts'
import {
  larkStartupDiagnostic,
  prepareLarkWrite,
  verifyCredentials,
} from './lark-settings.ts'
import { saveModel } from './model-setup.ts'
import { loadDesktopConfig, readSettings } from './settings.ts'

/**
 * Local attributes every input to this one person, and the app has no signed-in user,
 * so a routine the person creates here is set by the same `You` the chat records.
 */
const routineCreator = (channel: string) => {
  if (channel !== 'local')
    throw new Error(`The app has no identity to set routines in ${channel}`)
  return { id: 'local-user', name: 'You' }
}

const reloadDiagnostic =
  'The app could not reload Lark settings. Check the data directory and settings.json, then try again.'

/**
 * What the bot signs a message with when it posts for this app. It names the app, not
 * a person: the app has no signed-in account and must not borrow the OS user's name.
 */
const larkAuthor = { id: 'vela-app', name: 'Vela app' }

/**
 * `LarkHost.submit` has one overload per shape, so the union is split before the call.
 * Both carry the app's own author; the host signs the text with it.
 */
const submitToLark = (host: LarkHost, input: LarkSubmit) =>
  'newTopic' in input
    ? host.submit({
        chatId: input.chatId,
        newTopic: input.newTopic,
        text: input.text,
        author: larkAuthor,
      })
    : host.submit({
        chatId: input.chatId,
        sessionId: input.sessionId,
        text: input.text,
        author: larkAuthor,
      })

/** Feishu documents no topic deep link, so the app opens the group it does document. */
const larkChatLink = (chatId: string) =>
  `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`

/** Owns the SDK in main. The renderer gets only the fixed preload contract. */
async function openHost(
  config: ReturnType<typeof loadDesktopConfig>,
  loadLark: boolean,
  larkStartupError?: string,
) {
  const cwd = config.cwd
  const larkSettings = config.extensionConfig.lark ?? {}
  const model = process.env.VELA_MODEL?.startsWith('faux:')
    ? await (await import('@glows777/vela-core/testing')).loadFauxScenario(
        process.env.VELA_MODEL.slice(5),
      )
    : config.settings.defaultModel
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
  const vela = createChannelVela({
    cwd,
    dataDir: config.dataDir,
    model,
    providers: config.providers,
    credentials: config.credentials,
    thinkingLevel: config.settings.defaultThinkingLevel,
    sessionResources: config.sessionResources,
    limits: config.settings.limits,
    autoCompaction: config.settings.autoCompaction,
    shellPath: resolveShellPath(config.settings.shellPath, {
      env: process.env,
      platform: process.platform,
    }),
    extensionConfig: config.extensionConfig,
    extensions: [
      ...(loadLark ? [lark(transport ? { transport } : {})] : []),
      local({}),
    ],
  })
  /**
   * A model handed to the host (`VELA_MODEL=faux:<scenario>`) skips the setup screen: nothing is
   * saved, and the host answers with that model.
   */
  const directModel = typeof model === 'object'
  const settings = () => {
    try {
      return readSettings({
        agentDir: config.agentDir,
        cwd,
        directModel,
        larkLoaded: loadLark,
        larkStartupError,
        hasAvailableModel: vela.models().length > 0,
      })
    } catch {
      throw new Error(
        'Could not read desktop settings. Check the data directory, settings.json, models.json and auth.json, then try again.',
      )
    }
  }
  const off: (() => void)[] = []
  try {
    await vela.ready()
    const publish = (event: Event) => {
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed()) window.webContents.send(EVENT, event)
    }
    const names = new Set(vela.channels().map((channel) => channel.name))
    /** The Lark host's own reads (`chats`, `messages`, `onEvent`); the base contract has no chat list. */
    const larkHost = names.has('lark')
      ? (vela.channel('lark') as LarkHost)
      : undefined
    for (const name of names) {
      const host = vela.channel(name)
      off.push(
        host.onSession((value) =>
          publish({
            type: 'session',
            channel: name,
            value: {
              ...value,
              session: { ...value.session, channel: name },
            },
          }),
        ),
      )
      off.push(
        host.onStatus((value) =>
          publish({
            type: 'status',
            channel: name,
            value: {
              ...value,
              ...(value.rootId && {
                sessionId: channelSessionId(name, value.chatId, value.rootId),
              }),
            },
          }),
        ),
      )
      off.push(
        host.onConnection((value) =>
          publish({ type: 'connection', channel: name, value }),
        ),
      )
    }
    const localHost = vela.channel('local')
    off.push(
      localHost.onEvent((value) =>
        publish({ type: 'local', channel: 'local', value }),
      ),
    )
    if (larkHost)
      off.push(
        larkHost.onEvent((value) =>
          publish({ type: 'lark', channel: 'lark', value }),
        ),
      )
    /** Every channel's recorded sessions, tagged with the channel that owns them. */
    const sessions = (channel: string, chatId?: string) =>
      vela
        .channel(channel)
        .sessions(chatId)
        .map((session) => ({ ...session, channel }))
    const projects = async () =>
      larkHost
        ? [
            ...localHost.projects(),
            ...(await larkHost.chats()).map((chat) => ({
              id: chat.chatId,
              channel: 'lark' as const,
              ...(chat.name ? { name: chat.name } : {}),
              sessionId: channelSessionId('lark', chat.chatId),
            })),
          ]
        : localHost.projects()
    await vela.startChannels()
    const handle = async (
      request: Exclude<Request, { method: 'saveLark' }>,
    ) => {
      switch (request.method) {
        case 'channels':
          return vela.channels()
        case 'settings':
          return settings()
        case 'saveModel': {
          const saved = await saveModel({
            agentDir: config.agentDir,
            input: request.input,
            env: process.env,
          })
          vela.configureProvider(saved.provider, saved.definition)
          vela.setDefaults(
            saved.ref,
            // The host's own default when settings.json has no level (core's DEFAULT_THINKING_LEVEL).
            config.settings.defaultThinkingLevel ?? 'medium',
          )
          return settings()
        }
        case 'sessions':
          return sessions(request.channel, request.chatId)
        case 'connection':
          return vela.channel(request.channel).connection()
        case 'submit':
          if (request.channel === 'local' && 'projectId' in request.message) {
            const receipt = await localHost.submit(request.message)
            return { outcome: 'posted' as const, ...receipt }
          }
          if (request.channel === 'lark' && 'chatId' in request.message) {
            if (!larkHost) throw new Error('Lark is not available in this app')
            try {
              const receipt = await submitToLark(larkHost, request.message)
              return { outcome: 'posted' as const, ...receipt }
            } catch (error) {
              // The bot may already have posted; the caller re-reads instead of resending.
              if (!(error instanceof LarkSubmitError)) throw error
              return {
                outcome: error.outcome,
                ...(error.messageId ? { messageId: error.messageId } : {}),
                error: error.message,
              }
            }
          }
          if ('channelId' in request.message) {
            const receipt = await vela
              .channel(request.channel)
              .submit(request.message as IncomingMessage)
            return { outcome: 'posted' as const, ...receipt }
          }
          throw new Error('Invalid channel message')
        case 'stop':
          return vela
            .channel(request.channel)
            .stop(request.target, request.runId)
        case 'projects':
          return projects()
        case 'openProject':
          return localHost.openProject(request.input)
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
          return localHost.messages(request.input)
        case 'larkMessages': {
          if (!larkHost) throw new Error('Lark is not available in this app')
          const page = await larkHost.messages(request.input)
          return {
            messages: page.messages,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          }
        }
        case 'openLarkChat': {
          if (!larkHost) throw new Error('Lark is not available in this app')
          const chats = await larkHost.chats()
          if (!chats.some((chat) => chat.chatId === request.chatId))
            throw new Error('Open a Lark group that is enabled in this app')
          await shell.openExternal(larkChatLink(request.chatId))
          return
        }
        case 'listRoutines':
          return vela
            .channel(request.channel)
            .routines.list({ chatId: request.chatId })
        case 'createRoutine':
          return vela.channel(request.channel).routines.create(request.target, {
            ...request.input,
            creator: routineCreator(request.channel),
          })
        case 'editRoutine':
          return vela
            .channel(request.channel)
            .routines.edit(
              { chatId: request.chatId },
              request.id,
              request.input,
            )
        case 'cancelRoutine':
          return vela
            .channel(request.channel)
            .routines.cancel({ chatId: request.chatId }, request.id)
        default:
          throw new Error('Unknown desktop request')
      }
    }
    return {
      settings,
      handle,
      checkIdle() {
        if (
          vela.channels().some(({ name }) =>
            vela
              .channel(name)
              .sessions()
              .some(
                (session) =>
                  session.state === 'running' || session.state === 'queued',
              ),
          )
        )
          throw new Error(
            'A session is still running or queued. Wait for it to finish before changing Lark settings.',
          )
      },
      dispose: async () => {
        for (const stop of off) stop()
        await vela.dispose()
      },
    }
  } catch (error) {
    for (const stop of off) stop()
    await vela.dispose().catch(() => {})
    throw error
  }
}

/** Invalid Lark configuration must leave Settings and Local available across launches. */
function openAvailableHost(config: ReturnType<typeof loadDesktopConfig>) {
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

/** Only writing settings and replacing the host require exclusive access. */
export async function startHost() {
  let workingConfig = loadDesktopConfig(process.cwd())
  type Host = Awaited<ReturnType<typeof openHost>>
  let host: Promise<Host> | undefined = Promise.resolve(
    await openAvailableHost(workingConfig),
  )
  let barrier = Promise.resolve()
  const active = new Set<Promise<unknown>>()
  let closing = false
  const verify =
    process.env.VELA_DESKTOP_LARK === 'fake'
      ? (await import('./settings-transport.ts')).verifySettingsCredentials
      : verifyCredentials

  // All readers share one recovery attempt. A repaired directory can be retried on the next request.
  const restoreLocal = () =>
    openHost(workingConfig, false, reloadDiagnostic).catch(() => {
      host = undefined
      throw new Error(
        'Could not restore Local. Check the data directory and settings.json, then try again.',
      )
    })
  const current = () => (host ??= restoreLocal())
  const read = <T>(operation: (live: Host) => T) => {
    const pending = barrier.then(current).then(operation)
    const settled = pending.then(
      () => {},
      () => {},
    )
    active.add(settled)
    void settled.then(() => active.delete(settled))
    return pending
  }
  const section = () => {
    try {
      return (
        loadDesktopConfig(workingConfig.cwd, workingConfig.agentDir)
          .extensionConfig.lark ?? {}
      )
    } catch {
      throw new Error(
        'Could not read Lark settings. Check settings.json and try again.',
      )
    }
  }
  const save = async (
    input: Extract<Request, { method: 'saveLark' }>['input'],
  ) => {
    const before = await read((live) => {
      live.checkIdle()
      return section()
    })
    const write = await prepareLarkWrite(
      workingConfig.agentDir,
      before,
      input,
      verify,
    )
    if (closing) throw new Error('The app is closing.')
    const saved = Promise.all([barrier, ...active]).then(async () => {
      const previous = await current()
      previous.checkIdle()
      await write(section())
      // Never dispatch to a disposed SDK. Release its Lark connection before starting the replacement.
      host = previous.dispose().then(
        async () => {
          try {
            const config = loadDesktopConfig(
              workingConfig.cwd,
              workingConfig.agentDir,
            )
            const next = await openAvailableHost(config)
            workingConfig = config
            return next
          } catch {
            return restoreLocal()
          }
        },
        () => {
          // Ownership is uncertain. A second normal Lark host must wait for a fresh process.
          throw new Error(
            'Could not safely stop the desktop host. Quit and reopen Vela before changing Lark settings.',
          )
        },
      )
      return (await host).settings()
    })
    barrier = saved.then(
      () => {},
      () => {},
    )
    return saved
  }
  ipcMain.handle(REQUEST, (_event, request: Request) =>
    request.method === 'saveLark'
      ? save(request.input)
      : read((live) => live.handle(request)),
  )
  return async () => {
    closing = true
    ipcMain.removeHandler(REQUEST)
    await Promise.all([barrier, ...active])
    await (await host?.catch(() => undefined))?.dispose()
  }
}
