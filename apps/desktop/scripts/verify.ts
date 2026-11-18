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
const alpha = resolve(scratch, 'alpha')
const scenario = resolve(scratch, 'faux.json')
const shell = resolve(scratch, 'shell')
const shellMarker = resolve(scratch, 'shell-used')
const badConfig = process.env.VELA_DESKTOP_VERIFY_BAD_CONFIG === '1'
const disabledConfig = process.env.VELA_DESKTOP_VERIFY_DISABLED === '1'
await Promise.all(
  [home, data, profile, project, alpha].map((path) =>
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
      { text: 'Alpha answer' },
      { text: 'Second answer' },
    ],
    // Background requests (memory consolidation) use generateText; without their
    // own queue they would consume the scripted stream answers above.
    generate: Array.from({ length: 20 }, () => ({
      text: 'Compacted history',
    })),
  }),
)
const env = {
  ...process.env,
  HOME: home,
  VELA_DIR: data,
  VELA_MODEL: `faux:${scenario}`,
  VELA_DESKTOP_SHELL_MARKER: shellMarker,
  VELA_DESKTOP_TRACE: '1',
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
/** The model answers in the background; poll the recorded history until the text lands. */
const waitForText = async (
  page: Page,
  projectId: string,
  sessionId: string,
  text: string,
  timeout = 30_000,
) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const listing = await page.evaluate(
      ({ projectId, sessionId }) =>
        window.vela.messages({ projectId, sessionId }),
      { projectId, sessionId },
    )
    if (listing.messages.some((message) => message.text === text))
      return listing.messages
    await Bun.sleep(50)
  }
  throw new Error(`No "${text}" in ${sessionId} within ${timeout}ms`)
}

/**
 * The #415 contract through the real preload bridge, without touching the product UI:
 * channels, project and session reads, submit, Stop with a stale run, images, paging.
 */
const bridgeJourney = async (page: Page) => {
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
  await snapshot(page, 'home-empty')

  const created = await page.evaluate(
    (cwd) => window.vela.openProject({ cwd }),
    project,
  )
  assert.equal(created.cwd, project)
  const receipt = await page.evaluate(
    ({ projectId, sessionId }) =>
      window.vela.submit('local', {
        projectId,
        sessionId,
        text: 'Hello from desktop',
      }),
    { projectId: created.id, sessionId: created.sessionId },
  )
  assert.equal(typeof receipt.messageId, 'string')
  const messages = await waitForText(
    page,
    created.id,
    created.sessionId,
    'Desktop faux reply',
  )
  assert.equal(messages.at(-1)?.role, 'assistant')
  const state = await page.evaluate(
    async ({ projectId }) => ({
      sessions: await window.vela.sessions('local', projectId),
      stopped: await window.vela.stop(
        'local',
        { chatId: projectId },
        'missing-run',
      ),
      observed: window.observedDesktopEvents ?? [],
    }),
    { projectId: created.id },
  )
  assert(
    state.sessions.some((session) => session.sessionId === created.sessionId),
  )
  assert.equal(state.stopped, false)
  assert(state.observed.includes('local') && state.observed.includes('session'))
  assert.equal(
    await readFile(shellMarker, 'utf8'),
    'used',
    'Configured shellPath is used by the SDK host',
  )
  checks.push(
    'The real window hosts the SDK: channels, project, session, submit, Stop and events answer through preload.',
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
      projectId: created.id,
      image,
      anchor: messages[0]!.id,
    },
  )
  await waitForText(page, created.id, created.sessionId, 'Image processed')
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
  checks.push(
    'An image input survives normalization into the session transcript.',
  )

  const paged = await page.evaluate(
    async ({ projectId, sessionId }) => {
      const texts: string[] = []
      let after: string | undefined
      let pages = 0
      do {
        const listing = await window.vela.messages({
          projectId,
          sessionId,
          after,
          limit: 1,
        })
        texts.push(...listing.messages.map((message) => message.text))
        after = listing.nextCursor
        pages += 1
      } while (after)
      return { texts, pages }
    },
    { projectId: created.id, sessionId: created.sessionId },
  )
  assert(paged.pages > 1, 'Reading with limit 1 walks several pages')
  assert.equal(paged.texts.at(-1), 'Image processed')
  assert(paged.texts.includes('Desktop faux reply'))
  checks.push(
    'History reads page by page with the after cursor and keeps its order.',
  )
}

/** Journey 1: a Local project, a short question in its chat, the answer. */
const journeyOne = async (page: Page) => {
  await page.getByRole('heading', { name: 'Home', exact: true }).waitFor()
  const sidebar = page.getByLabel('Sidebar')
  await sidebar
    .getByRole('heading', { name: 'Projects', exact: true })
    .waitFor()
  await sidebar.getByRole('button', { name: 'New project' }).waitFor()
  await page.getByRole('button', { name: 'New session' }).waitFor()
  checks.push(
    'Home shows the frame: wordmark, New session, the projects list and New project.',
  )

  await sidebar.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByText('New project', { exact: true }).waitFor()
  const create = dialog.getByRole('button', { name: 'Create project' })
  assert.equal(
    await create.isDisabled(),
    true,
    'Create project stays disabled without a folder',
  )
  await dialog.getByLabel('Folder path').fill(alpha)
  await dialog.getByLabel('Name').fill('Alpha')
  checks.push(
    'New project asks for a folder and a name, and cannot be submitted while the folder is empty.',
  )
  await create.click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByRole('heading', { name: 'Alpha', exact: true }).waitFor()
  const header = page.locator('header')
  assert(
    (await header.textContent())?.includes(alpha),
    'The header names the folder',
  )
  assert.equal(await header.getByText('Local', { exact: true }).count(), 1)
  checks.push(
    'Creating a project opens it, with its Local tag and folder in the header.',
  )

  await sidebar.getByRole('button', { name: 'Alpha Local' }).waitFor()
  await page.getByText(/Ask Vela about this folder/).waitFor()
  checks.push('The project appears in the sidebar and its chat starts empty.')

  const composer = page.getByLabel('Message Vela in this project')
  await composer.fill('What does this project contain?')
  await page.getByRole('button', { name: 'Send' }).click()
  await page
    .getByText('What does this project contain?', { exact: true })
    .waitFor()
  checks.push("The person's message appears as a bubble.")

  await page
    .getByText('Alpha answer', { exact: true })
    .waitFor({ timeout: 30_000 })
  assert.equal(
    await page
      .locator('[data-role="user"]')
      .getByText('What does this project contain?', { exact: true })
      .count(),
    1,
  )
  assert.equal(
    await page
      .locator('[data-role="assistant"]')
      .getByText('Alpha answer', { exact: true })
      .count(),
    1,
  )
  assert.equal(await composer.inputValue(), '')
  assert.equal(
    await page.evaluate(() =>
      document
        .querySelector('[aria-label="Project chat"]')
        ?.lastElementChild?.getAttribute('data-role'),
    ),
    'assistant',
  )
  checks.push(
    'Vela answers in plain text, the field clears, and the answer is the last turn.',
  )

  await page.reload()
  await page.getByRole('heading', { name: 'VELA', exact: true }).waitFor()
  await page
    .getByLabel('Sidebar')
    .getByRole('button', { name: 'Alpha Local' })
    .click()
  await page
    .getByText('What does this project contain?', { exact: true })
    .waitFor()
  await page.getByText('Alpha answer', { exact: true }).waitFor()
  checks.push(
    'After a reload the project and both messages come back from recorded history.',
  )

  const alphaId = await page.evaluate(async () => {
    const projects = await window.vela.projects()
    return projects.find((project) => project.name === 'Alpha')?.id
  })
  await page.getByRole('button', { name: 'Home', exact: true }).click()
  assert.equal(
    await page.getByLabel('Project', { exact: true }).inputValue(),
    alphaId,
    'Home starts on the project used last',
  )
  const homeComposer = page.getByLabel('Message Vela', { exact: true })
  await homeComposer.fill('A second question')
  await page.getByRole('button', { name: 'Send' }).click()
  await page
    .getByText('A second question', { exact: true })
    .waitFor({ timeout: 30_000 })
  await page
    .getByText('Second answer', { exact: true })
    .waitFor({ timeout: 30_000 })
  checks.push(
    'Sending from Home opens that project and shows the answer there.',
  )

  await page.emulateMedia({
    colorScheme: 'light',
    contrast: 'no-preference',
    forcedColors: 'none',
  })
  await page.waitForFunction(
    (expected) =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--vela-ink')
        .trim() === expected,
    tokens.tokens['vela-ink'].light,
  )
  const hint = page.getByText(/on this computer/)
  await hint.waitFor()
  assert(
    (await hint.textContent())?.includes(alpha),
    'The composer names the folder where Vela runs',
  )
  await noOverflow(page)
  await snapshot(page, 'journey-1-light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForFunction(
    (expected) =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--vela-ink')
        .trim() === expected,
    tokens.tokens['vela-ink'].dark,
  )
  await snapshot(page, 'journey-1-dark')
  await page.emulateMedia({ colorScheme: null })
  checks.push(
    'The composer names the folder where Vela runs, in light and dark, with no horizontal overflow.',
  )
}
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function waitForForge(closed: Promise<void>, destroy: () => void) {
  try {
    await withTimeout(closed, 5_000, 'Forge close')
  } catch (error) {
    destroy()
    throw error
  }
}
async function closeElectron(browser: import('playwright').Browser) {
  const page = browser.contexts()[0]?.pages()[0]
  if (!page || page.isClosed()) {
    await browser.close()
    return
  }
  const session = await browser.newBrowserCDPSession()
  const closed = page.waitForEvent('close')
  const request = session.send('Browser.close').catch((error: unknown) => error)
  try {
    await withTimeout(closed, 15_000, 'Electron window close')
  } finally {
    await browser.close()
  }
  const result = await request
  // Electron can close CDP before acknowledging Browser.close.
  if (result instanceof Error && !result.message.includes('has been closed'))
    throw result
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
      if (chunk.toString().includes('Desktop shutdown:'))
        process.stdout.write(chunk)
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
      console.log('Desktop verification: starting bridge journey')
      await bridgeJourney(page)
      console.log('Desktop verification: bridge journey passed')
      console.log('Desktop verification: starting journey 1')
      await journeyOne(page)
      console.log('Desktop verification: journey 1 passed')
    } finally {
      console.log('Desktop verification: closing Electron')
      await closeElectron(browser)
      console.log('Desktop verification: Electron closed')
    }
  } finally {
    if (child.pid && child.exitCode === null)
      process.kill(-child.pid, 'SIGTERM')
    console.log('Desktop verification: waiting for Forge to close')
    await waitForForge(closed, () => {
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref()
    })
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
    await bridgeJourney(page)
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
