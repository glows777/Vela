import path from 'node:path'
import { app, BrowserWindow, nativeTheme, session } from 'electron'
import tokens from '../design/tokens.json'

const canvas = tokens.tokens['vela-white']

const createWindow = () => {
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
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const entry = process.argv.includes('--vela-specimen')
      ? 'specimen.html'
      : 'index.html'
    void window.loadURL(new URL(entry, MAIN_WINDOW_VITE_DEV_SERVER_URL).href)
  } else {
    void window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    )
  }
}

void app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, respond) => respond(false),
  )
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
