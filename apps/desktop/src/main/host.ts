import type { IncomingMessage } from '@glows777/vela-channels'
import { createChannelVela, local } from '@glows777/vela-channels'
import { resolveShellPath } from '@glows777/vela-core'
import { lark } from '@glows777/vela-lark'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { EVENT, type Event, REQUEST, type Request } from '../shared/bridge.ts'
import { verifyCredentials, writeLark } from './lark-settings.ts'
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

/** Owns the SDK in main. The renderer gets only the fixed preload contract. */
async function openHost(localOnly = false) {
  const cwd = process.cwd()
  const config = loadDesktopConfig(cwd)
  const larkSettings = config.extensionConfig.lark ?? {}
  const loadLark =
    !localOnly &&
    larkSettings.runInApp !== false &&
    config.extensions.some(
      (extension) => extension.name === 'lark' && 'builtin' in extension,
    )
  const fake =
    process.env.VELA_DESKTOP_LARK === 'fake'
      ? await import('./settings-transport.ts')
      : undefined
  const model = process.env.VELA_MODEL?.startsWith('faux:')
    ? await (await import('@glows777/vela-core/testing')).loadFauxScenario(
        process.env.VELA_MODEL.slice(5),
      )
    : config.settings.defaultModel
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
      ...(loadLark
        ? [
            lark(
              fake
                ? {
                    transport: fake.settingsTransport(
                      larkSettings.appId,
                      larkSettings.appSecret,
                    ),
                  }
                : {},
            ),
          ]
        : []),
      local({}),
    ],
  })
  /**
   * A model handed to the host (`VELA_MODEL=faux:<scenario>`) skips the setup screen: nothing is
   * saved, and the host answers with that model.
   */
  const directModel = typeof model === 'object'
  const settings = () =>
    readSettings({
      agentDir: config.agentDir,
      cwd,
      directModel,
      larkLoaded: loadLark,
      hasAvailableModel: vela.models().length > 0,
    })
  const off: (() => void)[] = []
  try {
    await vela.ready()
    const publish = (event: Event) => {
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed()) window.webContents.send(EVENT, event)
    }
    for (const { name } of vela.channels()) {
      const host = vela.channel(name)
      off.push(
        host.onSession((value) =>
          publish({ type: 'session', channel: name, value }),
        ),
      )
      off.push(
        host.onStatus((value) =>
          publish({ type: 'status', channel: name, value }),
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
          return vela.channel(request.channel).sessions(request.chatId)
        case 'connection':
          return vela.channel(request.channel).connection()
        case 'submit':
          if (request.channel === 'local' && 'projectId' in request.message)
            return localHost.submit(request.message)
          if ('channelId' in request.message)
            return vela
              .channel(request.channel)
              .submit(request.message as IncomingMessage)
          throw new Error('Invalid channel message')
        case 'stop':
          return vela
            .channel(request.channel)
            .stop(request.target, request.runId)
        case 'projects':
          return localHost.projects()
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
      localOnly,
      settings,
      handle,
      saveLark: (input: Extract<Request, { method: 'saveLark' }>['input']) =>
        writeLark(
          config.agentDir,
          loadDesktopConfig(cwd, config.agentDir).extensionConfig.lark ?? {},
          input,
          fake?.verifySettingsCredentials ?? verifyCredentials,
          () => {
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
        ),
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
function openAvailableHost() {
  return openHost().catch(() => openHost(true))
}

/** A save waits for admitted requests and owns the host until its replacement is ready. */
export async function startHost() {
  let host = await openAvailableHost()
  let barrier = Promise.resolve()
  const active = new Set<Promise<unknown>>()
  ipcMain.handle(REQUEST, (_event, request: Request) => {
    if (request.method === 'saveLark') {
      const saved = Promise.all([barrier, ...active]).then(async () => {
        await host.saveLark(request.input)
        await host.dispose()
        host = await openAvailableHost()
        if (host.localOnly)
          throw new Error(
            'Lark settings were saved, but Lark could not start. Check settings.json. Local is available.',
          )
        return host.settings()
      })
      barrier = saved.then(
        () => {},
        () => {},
      )
      return saved
    }
    const pending = barrier.then(() => host.handle(request))
    const settled = pending.then(
      () => {},
      () => {},
    )
    active.add(settled)
    void settled.then(() => active.delete(settled))
    return pending
  })
  return async () => {
    ipcMain.removeHandler(REQUEST)
    await Promise.all([barrier, ...active])
    await host.dispose()
  }
}
