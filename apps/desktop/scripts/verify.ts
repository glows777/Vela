import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
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
import { verifyControls } from './verify-controls.ts'

const root = resolve(import.meta.dir, '..')
const evidence =
  process.env.VELA_DESKTOP_EVIDENCE ??
  (await mkdtemp('/tmp/vela-desktop-evidence-'))
const profile = await realpath(
  await mkdtemp(resolve(tmpdir(), 'vela-desktop-profile-')),
)
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
  await page.evaluate(() => document.fonts.ready)
  assert.equal(
    await page.evaluate(() => document.fonts.check('800 26px BarlowCondensed')),
    true,
  )
}
async function development() {
  const child = spawn(
    'bunx',
    [
      '--no-install',
      'electron-forge',
      'start',
      '--',
      '--vela-specimen',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
    ],
    {
      cwd: root,
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
    const browser = await chromium.connectOverCDP(await endpoint)
    try {
      const page = browser.contexts()[0]!.pages()[0]!
      watch(page)
      await page.waitForLoadState('networkidle')
      await page
        .getByRole('heading', { name: 'Vela design foundation' })
        .waitFor()
      checks.push(
        'Development preview is ready on first load, before any media-mode reload.',
      )
      await rendererSafety(page)
      checks.push(...(await verifyControls(page, evidence)))
      await page.setViewportSize({ width: 800, height: 600 })
      await noOverflow(page)
      await snapshot(page, 'specimen-minimum')
      checks.push('Minimum preview layout passes.')
      await page.goto(new URL('index.html', page.url()).href)
      await page.getByRole('heading', { name: 'VELA', exact: true }).waitFor()
      await snapshot(page, 'shell-development')
      assert.equal(await page.getByRole('button').count(), 0)
      checks.push('Development shell is branded and has no product controls.')
    } finally {
      await browser.close()
    }
  } finally {
    if (child.pid && child.exitCode === null)
      process.kill(-child.pid, 'SIGTERM')
    await closed
    await Bun.write(resolve(evidence, 'forge.log'), output)
  }
}
async function packaged(appPath: string) {
  const appRoot = resolve(appPath)
  const resources = resolve(appRoot, 'Contents/Resources')
  const app = await _electron.launch({
    executablePath: resolve(appRoot, 'Contents/MacOS/Vela'),
    args: [`--user-data-dir=${profile}`],
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
    assert.equal(await page.getByRole('button').count(), 0)
    const asar = await import('@electron/asar')
    const files = asar.listPackage(resolve(resources, 'app.asar'), {
      isPack: false,
    })
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
        /Vela design foundation|Select sample|specimen\.html|@glows777\/vela/.test(
          text,
        ),
        false,
        `No demo or SDK code in ${file}`,
      )
    }
    const licenses = await readdir(resources)
    assert(
      licenses.includes('Barlow-LICENSE.txt') &&
        licenses.includes('JapaneseFonts-LICENSE.txt') &&
        licenses.includes('LICENSE.txt'),
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
    checks.push(
      'Packaged app launches with isolated renderer, minimum window, system light/dark, bundled font licenses, and no specimen or SDK code.',
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
    JSON.stringify({ passed: true, checks, errors }, null, 2),
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
  await rm(profile, { recursive: true, force: true })
}
