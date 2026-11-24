import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultAgentDir } from '@glows777/vela/legacy-desktop'
import { app, BrowserWindow, nativeTheme, session } from 'electron'
import tokens from '../../design/tokens.json'
import { startHost } from './restart-host.ts'

const mainDir = path.dirname(fileURLToPath(import.meta.url))
const canvas = tokens.tokens['vela-white']

const LEGACY_CONFIG_NAMES = [
  'settings.json',
  'models.json',
  'mcp.json',
] as const
const LEGACY_CONFIG_NAME_SET = new Set<string>(LEGACY_CONFIG_NAMES)

function extractLegacyFiles(error: unknown, agentDir: string): string[] {
  const message = error instanceof Error ? error.message : String(error)
  const match =
    /found legacy config file\(s\) \(([^)]+)\) without config\.json/i.exec(
      message,
    )
  if (match) {
    return match[1]!
      .split(',')
      .map((name) => name.trim())
      .filter((name) => LEGACY_CONFIG_NAME_SET.has(name))
  }
  if (!existsSync(path.join(agentDir, 'config.json'))) {
    return LEGACY_CONFIG_NAMES.filter((name) =>
      existsSync(path.join(agentDir, name)),
    )
  }
  return []
}

const createWindow = (hostError: false | { legacyFiles: string[] } = false) => {
  const colorScheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  const theme = nativeTheme.shouldUseHighContrastColors
    ? 'high-contrast'
    : colorScheme
  const isMac = process.platform === 'darwin'
  const window = new BrowserWindow({
    title: 'Vela',
    width: 1180,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: canvas[theme],
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 15 },
        }
      : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(mainDir, 'preload.cjs'),
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const entry = process.argv.includes('--vela-specimen')
      ? 'specimen.html'
      : 'index.html'
    const url = new URL(entry, MAIN_WINDOW_VITE_DEV_SERVER_URL)
    if (hostError) {
      url.searchParams.set('hostError', '1')
      if (hostError.legacyFiles.length > 0)
        url.searchParams.set('legacyFiles', hostError.legacyFiles.join(','))
    }
    void window.loadURL(url.href)
  } else {
    void window.loadFile(
      path.join(mainDir, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      hostError
        ? {
            query: {
              hostError: '1',
              ...(hostError.legacyFiles.length > 0
                ? { legacyFiles: hostError.legacyFiles.join(',') }
                : {}),
            },
          }
        : undefined,
    )
  }
}

let dispose: (() => Promise<void>) | undefined
let closing = false
void app.whenReady().then(async () => {
  let hostError: false | { legacyFiles: string[] } = false
  try {
    dispose = await startHost()
  } catch (error) {
    hostError = {
      legacyFiles: extractLegacyFiles(error, defaultAgentDir(process.env)),
    }
    console.error('Vela startup failed:', error)
  }
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, respond) => respond(false),
  )
  createWindow(hostError)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(hostError)
  })
})

app.on('window-all-closed', () => {
  if (process.env.VELA_DESKTOP_TRACE === '1')
    console.log('Desktop shutdown: window-all-closed')
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (process.env.VELA_DESKTOP_TRACE === '1')
    console.log('Desktop shutdown: before-quit')
  if (closing || !dispose) return
  event.preventDefault()
  closing = true
  void dispose().finally(() => {
    if (process.env.VELA_DESKTOP_TRACE === '1')
      console.log('Desktop shutdown: disposal settled')
    app.quit()
  })
})
