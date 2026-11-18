import type { IncomingMessage } from '@glows777/vela-channels'
import { createChannelVela, local } from '@glows777/vela-channels'
import { loadConfig, resolveShellPath } from '@glows777/vela-core'
import { lark, larkConfig } from '@glows777/vela-lark'
import { BrowserWindow, ipcMain } from 'electron'
import { EVENT, type Event, REQUEST, type Request } from '../shared/bridge.ts'

/** Owns the SDK in main. The renderer gets only the fixed preload contract. */
export async function startHost() {
  const cwd = process.cwd()
  const config = loadConfig({
    deferSystemFiles: true,
    cwd,
    env: process.env,
    trusted: false,
    builtins: ['background', 'memory', 'rag', 'web', 'lark', 'mcp', 'todo'],
  })
  const larkSettings = larkConfig.resolve(config.extensionConfig.lark ?? {}, {
    cwd,
    agentDir: config.agentDir,
    projectDir: cwd,
    trusted: false,
    env: process.env,
  })
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
    extensionConfig: { ...config.extensionConfig, lark: larkSettings },
    extensions: [
      ...(config.extensions.some(
        (extension) => extension.name === 'lark' && 'builtin' in extension,
      )
        ? [lark()]
        : []),
      local({}),
    ],
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
    ipcMain.handle(REQUEST, async (_event, request: Request) => {
      switch (request.method) {
        case 'channels':
          return vela.channels()
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
        case 'messages':
          return localHost.messages(request.input)
        default:
          throw new Error('Unknown desktop request')
      }
    })
    return async () => {
      ipcMain.removeHandler(REQUEST)
      for (const stop of off) stop()
      await vela.dispose()
    }
  } catch (error) {
    for (const stop of off) stop()
    await vela.dispose().catch(() => {})
    throw error
  }
}
