import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron, chromium, type Page } from 'playwright'
import tokens from '../design/tokens.json'
import type { DesktopBridge } from '../src/shared/bridge.ts'
import { verifyControls } from './verify-controls.ts'

declare global {
  interface Window {
    vela: DesktopBridge
    observedDesktopEvents?: string[]
  }
}

const root = resolve(import.meta.dir, '..')
const evidence =
  process.env.VELA_DESKTOP_EVIDENCE ??
  (await mkdtemp('/tmp/vela-desktop-evidence-'))
const scratch = await realpath(
  await mkdtemp(resolve(tmpdir(), 'vela-desktop-')),
)
const home = resolve(process.env.VELA_DESKTOP_HOME ?? resolve(scratch, 'home'))
const dataParent = resolve(process.env.VELA_DIR ?? scratch)
await mkdir(dataParent, { recursive: true })
const data = await mkdtemp(resolve(dataParent, 'vela-data-'))
const profile = resolve(scratch, 'user-data')
const project = resolve(scratch, 'project')
const scenario = resolve(scratch, 'faux.json')
const shell = resolve(scratch, 'shell')
const shellMarker = resolve(scratch, 'shell-used')
const badConfig = process.env.VELA_DESKTOP_VERIFY_BAD_CONFIG === '1'
const disabledConfig = process.env.VELA_DESKTOP_VERIFY_DISABLED === '1'
const historyMode = process.env.VELA_DESKTOP_VERIFY_HISTORY === '1'
await Promise.all(
  [home, data, profile, project].map((path) =>
    mkdir(path, { recursive: true }),
  ),
)
await Bun.write(
  shell,
  '#!/bin/sh\nprintf used > "$VELA_DESKTOP_SHELL_MARKER"\nexec /bin/bash "$@"\n',
)
await chmod(shell, 0o755)
const settingsPath = resolve(data, 'settings.json')
if (await Bun.file(settingsPath).exists())
  throw new Error(`Refusing to overwrite existing settings: ${settingsPath}`)
await Bun.write(
  settingsPath,
  badConfig
    ? '{ invalid'
    : JSON.stringify({
        shellPath: shell,
        ...(disabledConfig
          ? { extensions: ['-builtin:web', '-builtin:lark'] }
          : {}),
      }),
)
await Bun.write(
  scenario,
  JSON.stringify({
    responses: [
      {
        toolCalls: [{ name: 'bash', input: { command: 'printf shell-check' } }],
      },
      { text: 'Desktop faux reply' },
      { text: 'Image processed' },
      ...(historyMode
        ? Array.from({ length: 26 }, (_, index) => ({
            text: `History reply ${index}`,
          }))
        : []),
    ],
  }),
)
const env = {
  ...process.env,
  HOME: home,
  VELA_DIR: data,
  VELA_MODEL: `faux:${scenario}`,
  VELA_DESKTOP_SHELL_MARKER: shellMarker,
  LARK_APP_ID: '',
  LARK_APP_SECRET: '',
  LARK_OWNERS: '',
}
await mkdir(evidence, { recursive: true })
const errors: string[] = []
const checks: string[] = []
const watch = (page: Page) => {
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('requestfailed', (request) =>
    errors.push(`${request.url()}: ${request.failure()?.errorText}`),
  )
}
const noOverflow = async (page: Page) =>
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    'No horizontal overflow',
  )
const snapshot = async (page: Page, name: string) => {
  await page.screenshot({
    path: resolve(evidence, `${name}.png`),
    fullPage: true,
    animations: 'disabled',
  })
}
const rendererSafety = async (page: Page) => {
  assert.equal(
    await page.evaluate(() => 'require' in window || 'process' in window),
    false,
    'Renderer has no Node globals',
  )
  assert.equal(
    await page.evaluate(async (fonts) => {
      const loaded = await Promise.all(
        fonts.map((font) =>
          document.fonts.load(`${font.weight} 26px ${font.family}`),
        ),
      )
      return loaded.every(
        (faces) =>
          faces.length > 0 && faces.every((face) => face.status === 'loaded'),
      )
    }, tokens.fonts),
    true,
    'Bundled fonts load',
  )
  assert.equal(
    await page
      .locator('img')
      .evaluateAll((images) =>
        images.every(
          (image) =>
            image instanceof HTMLImageElement &&
            image.complete &&
            image.naturalWidth > 0,
        ),
      ),
    true,
    'Local images load',
  )
}
const hostJourney = async (page: Page) => {
  const initial = await page.evaluate(async () => ({
    channels: await window.vela.channels(),
    local: await window.vela.connection('local'),
    lark: await window.vela.connection('lark'),
    projects: await window.vela.projects(),
  }))
  assert.deepEqual(initial.channels.map((channel) => channel.name).sort(), [
    'lark',
    'local',
  ])
  assert.equal(initial.local.connected, true)
  assert.equal(initial.lark.connected, false)
  assert.deepEqual(initial.projects, [])
  await page.evaluate(() => {
    const observed: string[] = []
    Object.assign(window, { observedDesktopEvents: observed })
    window.vela.onEvent((event) => observed.push(event.type))
  })
  await page.getByLabel('Project path').fill(project)
  await page.getByRole('button', { name: 'Open project' }).click()
  await page.getByLabel('Message').fill('Hello from desktop')
  await page.getByRole('button', { name: 'Send' }).click()
  await page
    .getByText('Desktop faux reply', { exact: true })
    .waitFor({ timeout: 30_000 })
  const state = await page.evaluate(async () => {
    const projects = await window.vela.projects()
    const first = projects[0]!
    return {
      projects,
      sessions: await window.vela.sessions('local', first.id),
      messages: await window.vela.messages({
        projectId: first.id,
        sessionId: first.sessionId,
      }),
      stopped: await window.vela.stop(
        'local',
        { chatId: first.id },
        'missing-run',
      ),
      observed: window.observedDesktopEvents ?? [],
    }
  })
  assert.equal(state.projects.length, 1)
  assert(
    state.sessions.some(
      (session) => session.sessionId === state.projects[0]!.sessionId,
    ),
  )
  assert(
    state.messages.messages.some(
      (message) => message.text === 'Desktop faux reply',
    ),
  )
  assert.equal(state.stopped, false)
  assert(state.observed.includes('local') && state.observed.includes('session'))
  assert.equal(
    await readFile(shellMarker, 'utf8'),
    'used',
    'Configured shellPath is used by the SDK host',
  )
  const image = (
    await readFile(resolve(root, '../../test/fixtures/images/blue.png'))
  ).toString('base64')
  await page.evaluate(
    async ({ projectId, image, anchor }) => {
      await window.vela.submit('local', {
        channelId: projectId,
        chatKind: 'group',
        senderId: 'local-user',
        senderName: 'You',
        text: 'Image probe',
        replyToId: anchor,
        images: [{ type: 'image', data: image, mimeType: 'image/png' }],
      })
    },
    {
      projectId: state.projects[0]!.id,
      image,
      anchor: state.messages.messages[0]!.id,
    },
  )
  await page
    .getByText('Image processed', { exact: true })
    .waitFor({ timeout: 30_000 })
  const deadline = Date.now() + 5000
  let savedImage = false
  while (!savedImage && Date.now() < deadline) {
    for await (const file of new Bun.Glob('**/transcript.jsonl').scan(data))
      if (
        (await Bun.file(resolve(data, file)).text()).includes('"type":"image"')
      )
        savedImage = true
    if (!savedImage) await Bun.sleep(50)
  }
  assert(savedImage, 'Image survived normalization into the session')
  if (historyMode) {
    await page.evaluate(
      async ({ projectId, sessionId }) => {
        for (let index = 0; index < 26; index++)
          await window.vela.submit('local', {
            projectId,
            sessionId,
            text: `History input ${index}`,
          })
      },
      {
        projectId: state.projects[0]!.id,
        sessionId: state.projects[0]!.sessionId,
      },
    )
    await page
      .getByText('History reply 25', { exact: true })
      .waitFor({ timeout: 30_000 })
    await page.reload()
    await page.getByLabel('Project path').fill(project)
    await page.getByRole('button', { name: 'Open project' }).click()
    await page
      .getByText('History reply 25', { exact: true })
      .waitFor({ timeout: 10_000 })
    checks.push('Reopening loads messages beyond the first history page.')
  }
  await snapshot(page, 'host-journey')
  checks.push(
    'Real window opened a Local project, sent a message, and rendered the faux reply.',
  )
}
async function closeElectron(browser: import('playwright').Browser) {
  const session = await browser.newBrowserCDPSession()
  try {
    await session.send('Browser.close')
  } catch (error) {
    // Electron can close the CDP connection before acknowledging Browser.close.
    if (!(error instanceof Error) || !error.message.includes('has been closed'))
      throw error
  } finally {
    await browser.close()
  }
}
async function development() {
  console.log('Desktop verification: launching development Electron')
  const child = spawn(
    'bunx',
    [
      '--no-install',
      'electron-forge',
      'start',
      '--',
      ...(badConfig ? [] : ['--vela-specimen']),
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
    ],
    {
      cwd: root,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const closed = new Promise<void>((accept) =>
    child.once('close', () => accept()),
  )
  let output = ''
  const endpoint = new Promise<string>((accept, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Forge launch timeout\n${output}`)),
      45_000,
    )
    const collect = (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(
        /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/,
      )
      if (match) {
        clearTimeout(timeout)
        accept(match[1]!)
      }
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Forge exited ${code}\n${output}`))
    })
  })
  try {
    const url = await endpoint
    console.log('Desktop verification: DevTools endpoint ready')
    const browser = await chromium.connectOverCDP(url)
    console.log('Desktop verification: connected to Electron')
    try {
      const context = browser.contexts()[0]!
      const page =
        context.pages()[0] ??
        (await context.waitForEvent('page', { timeout: 30_000 }))
      watch(page)
      await page.bringToFront()
      await page.waitForLoadState('networkidle')
      console.log('Desktop verification: first window loaded')
      if (badConfig) {
        await page
          .getByRole('alert')
          .getByText('Vela could not start. Check your settings and restart.')
          .waitFor()
        checks.push('Invalid configuration produces a visible startup error.')
        return
      }
      await page
        .getByRole('heading', { name: 'Vela design foundation' })
        .waitFor()
      checks.push(
        'Development preview is ready on first load, before any media-mode reload.',
      )
      await rendererSafety(page)
      checks.push(...(await verifyControls(page, evidence)))
      console.log('Desktop verification: specimen controls passed')
      await page.setViewportSize({ width: 800, height: 600 })
      await noOverflow(page)
      await snapshot(page, 'specimen-minimum')
      checks.push('Minimum preview layout passes.')
      await page.goto(new URL('index.html', page.url()).href)
      await page.getByRole('heading', { name: 'VELA', exact: true }).waitFor()
      await rendererSafety(page)
      await noOverflow(page)
      await snapshot(page, 'shell-development')
      if (disabledConfig) {
        assert.deepEqual(
          (await page.evaluate(() => window.vela.channels())).map(
            (channel) => channel.name,
          ),
          ['local'],
        )
        checks.push('CLI built-in switches load and disabled Lark stays off.')
        return
      }
      console.log('Desktop verification: starting host journey')
      await hostJourney(page)
      console.log('Desktop verification: host journey passed')
    } finally {
      console.log('Desktop verification: closing Electron')
      await closeElectron(browser)
      console.log('Desktop verification: Electron closed')
    }
  } finally {
    if (child.pid && child.exitCode === null)
      process.kill(-child.pid, 'SIGTERM')
    console.log('Desktop verification: waiting for Forge to close')
    await closed
    console.log('Desktop verification: Forge closed')
    await Bun.write(resolve(evidence, 'forge.log'), output)
  }
}
async function packaged(appPath: string) {
  const appRoot = resolve(appPath)
  const resources = resolve(
    appRoot,
    process.platform === 'darwin' ? 'Contents/Resources' : 'resources',
  )
  const app = await _electron.launch({
    executablePath: resolve(
      appRoot,
      process.platform === 'darwin' ? 'Contents/MacOS/Vela' : 'Vela',
    ),
    args: [`--user-data-dir=${profile}`],
    env,
    timeout: 30_000,
  })
  try {
    const page = await app.firstWindow()
    watch(page)
    await page.waitForLoadState('networkidle')
    await page.getByRole('heading', { name: 'VELA', exact: true }).waitFor()
    await rendererSafety(page)
    const settings = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!
      return { minimum: window.getMinimumSize() }
    })
    assert.deepEqual(settings.minimum, [800, 600])
    assert.equal(
      await app.evaluate(({ app }) => app.getPath('userData')),
      profile,
    )
    assert.deepEqual(
      await app.evaluate(() => ({
        home: process.env.HOME,
        nodeHome: process.getBuiltinModule('os').homedir(),
        data: process.env.VELA_DIR,
      })),
      { home, nodeHome: home, data },
      'Packaged Node main uses the scratch home and VELA_DIR',
    )
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(800, 600),
    )
    await noOverflow(page)
    await snapshot(page, 'packaged-minimum')
    await page.emulateMedia({
      colorScheme: null,
      contrast: 'no-preference',
      forcedColors: 'none',
    })
    for (const theme of ['light', 'dark'] as const) {
      await app.evaluate(({ nativeTheme }, value) => {
        nativeTheme.themeSource = value
      }, theme)
      await page.waitForFunction(
        (expected) =>
          getComputedStyle(document.documentElement)
            .getPropertyValue('--vela-ink')
            .trim() === expected,
        tokens.tokens['vela-ink'][theme],
      )
      await snapshot(page, `packaged-system-${theme}`)
    }
    await page.emulateMedia({ contrast: 'more' })
    await page.waitForFunction(
      (expected) =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--vela-ink')
          .trim() === expected,
      tokens.tokens['vela-ink']['high-contrast'],
    )
    await snapshot(page, 'packaged-system-high-contrast')
    await hostJourney(page)
    const asar = await import('@electron/asar')
    const files = asar.listPackage(resolve(resources, 'app.asar'), {
      isPack: false,
    })
    assert(
      files.some((file) => file.endsWith('/photon_rs_bg.wasm')),
      'Packaged SDK contains its image decoder',
    )
    assert.equal(
      files.some((file) => /specimen|preview/i.test(file)),
      false,
      'No specimen files in packaged app',
    )
    const scriptFiles = files.filter((file) =>
      /\.(js|cjs|html|css)$/.test(file),
    )
    for (const file of scriptFiles) {
      const text = asar
        .extractFile(resolve(resources, 'app.asar'), file.slice(1))
        .toString()
      assert.equal(
        /Vela design foundation|Select sample|specimen\.html/.test(text),
        false,
        `No specimen code in ${file}`,
      )
    }
    const licenses = await readdir(resources)
    assert(
      licenses.includes('Barlow-LICENSE.txt') &&
        licenses.includes('JapaneseFonts-LICENSE.txt') &&
        licenses.includes('LICENSE.txt') &&
        licenses.includes('LICENSE.md'),
    )
    assert(
      (
        await readFile(resolve(resources, 'Barlow-LICENSE.txt'), 'utf8')
      ).includes('SIL OPEN FONT LICENSE'),
    )
    assert(
      (await readFile(resolve(resources, 'LICENSE.txt'), 'utf8')).includes(
        'Copyright (c) 2026 Elia Kuratli',
      ),
    )
    assert(
      (await readFile(resolve(resources, 'LICENSE.md'), 'utf8')).includes(
        'Apache License',
      ),
    )
    checks.push(
      'Packaged app launches with scratch home/data/profile, isolated renderer, minimum window, system themes, bundled licenses, and no specimen.',
    )
  } finally {
    await app.close()
  }
}
try {
  const option = process.argv.indexOf('--packaged')
  if (option >= 0) {
    const path = process.argv[option + 1]
    assert(path, 'Pass the packaged .app path')
    await packaged(resolve(root, '../..', path))
  } else await development()
  assert.deepEqual(errors, [], 'No renderer console, page, or resource errors')
  await Bun.write(
    resolve(evidence, 'result.json'),
    JSON.stringify(
      { passed: true, checks, errors, home, data, profile },
      null,
      2,
    ),
  )
  console.log(checks.join('\n'))
  console.log(`Evidence: ${evidence}`)
} catch (error) {
  await Bun.write(
    resolve(evidence, 'result.json'),
    JSON.stringify(
      { passed: false, checks, errors, failure: String(error) },
      null,
      2,
    ),
  )
  throw error
} finally {
  await rm(data, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
}
