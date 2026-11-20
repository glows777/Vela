import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, nativeTheme, session } from 'electron'
import tokens from '../../design/tokens.json'
import { startHost } from './restart-host.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const canvas = tokens.tokens['vela-white']

const createWindow = (hostError = false) => {
  const colorScheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  const theme = nativeTheme.shouldUseHighContrastColors
    ? 'high-contrast'
    : colorScheme
  const window = new BrowserWindow({
    title: 'Vela',
    width: 1180,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: canvas[theme],
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const entry = process.argv.includes('--vela-specimen')
      ? 'specimen.html'
      : 'index.html'
    const url = new URL(entry, MAIN_WINDOW_VITE_DEV_SERVER_URL)
    if (hostError) url.searchParams.set('hostError', '1')
    void window.loadURL(url.href)
  } else {
    void window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      hostError ? { query: { hostError: '1' } } : undefined,
    )
  }
}

let dispose: (() => Promise<void>) | undefined
let closing = false
void app.whenReady().then(async () => {
  let hostError = false
  try {
    dispose = await startHost()
  } catch (error) {
    hostError = true
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
