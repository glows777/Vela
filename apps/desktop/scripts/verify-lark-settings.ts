import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { GOOD_KEY } from './verify-provider.ts'

/** Drive the Settings page and a Local chat in the same window across host replacements. */
export async function verifyLarkSettings(
  page: Page,
  dir: string,
  project: string,
  themes: (page: Page, name: string) => Promise<void>,
  hold: () => () => void,
  secret: string,
) {
  const path = join(dir, 'settings.json')
  const disk = async () => JSON.parse(await readFile(path, 'utf8'))
  const sidebar = page.getByLabel('Sidebar')
  const open = async () => {
    await sidebar.getByRole('button', { name: 'Settings' }).click()
    await page
      .getByLabel('Settings sections')
      .getByRole('button', { name: 'Lark' })
      .click()
  }
  const toggle = page.getByRole('switch', { name: 'Run Lark in this app' })
  const connected = page.getByText('Connected', { exact: true })
  const input = page.getByLabel('App secret', { exact: true })
  const save = page.getByRole('button', { name: 'Save credentials' })
  const submit = async (message: string) => {
    await sidebar.getByRole('button', { name: 'Setup project' }).click()
    const panel = page.getByRole('complementary', { name: 'Sessions' })
    const close = panel.getByRole('button', { name: 'Close sessions' })
    if (await close.isVisible()) {
      await close.click()
      await panel.waitFor({ state: 'detached' })
    }
    await page.getByLabel('Message Vela in this project').fill(message)
    await page.getByRole('button', { name: 'Send' }).click()
  }

  await page.goto(new URL('index.html', page.url()).href)
  await open()
  await page.getByText('oc_settings', { exact: true }).waitFor()
  const startup = page
    .getByRole('alert')
    .filter({ hasText: /duplicate chat IDs.*settings.json/i })
  await startup.waitFor({ timeout: 7000 })
  assert(
    await toggle.isChecked(),
    'A failed startup preserves desktop ownership',
  )
  assert(
    !JSON.stringify(await page.evaluate(() => window.vela.settings())).includes(
      secret,
    ),
  )
  assert(!(await startup.innerText()).includes(secret))
  await themes(page, 'lark-settings-startup-error')

  await submit('Can Local answer while Lark needs repair?')
  await page.getByText('Local answer', { exact: true }).nth(1).waitFor()
  await page.waitForFunction(
    async () =>
      !(await window.vela.sessions('local')).some(
        (s) => s.state === 'running' || s.state === 'queued',
      ),
  )
  await open()
  await toggle.click()
  await page.getByText('Off in this app', { exact: true }).waitFor()
  assert.equal(
    await startup.count(),
    0,
    'Turning ownership off clears the startup diagnostic even with the same invalid chats',
  )
  await page.getByRole('button', { name: 'Remove oc_duplicate' }).click()
  await page
    .getByText('oc_duplicate', { exact: true })
    .waitFor({ state: 'detached' })
  await toggle.click()
  await page.waitForFunction(
    async () => (await window.vela.settings()).lark.loaded,
  )
  assert.equal(await input.getAttribute('type'), 'password')
  await page.getByLabel('App ID', { exact: true }).fill('verify-app')
  await input.fill('invalid')
  const before = await readFile(path, 'utf8')
  await save.click()
  await page.getByRole('alert').waitFor()
  assert(
    (await readFile(path, 'utf8')) === before,
    'Rejected credentials leave settings intact',
  )
  await input.fill(secret)
  await save.click()
  await connected.waitFor()
  assert(
    (await input.inputValue()) === '',
    'A saved secret leaves the password field empty',
  )
  assert(
    await page.evaluate(
      async () => (await window.vela.connection('lark')).connected,
    ),
  )
  const safe = await page.evaluate(async () =>
    JSON.stringify(await window.vela.settings()),
  )
  assert(
    !safe.includes(secret) && !safe.includes(GOOD_KEY),
    'Settings excludes both saved secrets',
  )
  assert(!(await page.locator('body').innerText()).includes(secret))
  await themes(page, 'lark-settings-connected')

  await toggle.click()
  await page.getByText('Off in this app', { exact: true }).waitFor()
  assert.deepEqual(
    await page.evaluate(async () =>
      (await window.vela.channels()).map((c) => c.name),
    ),
    ['local'],
  )
  assert.equal((await disk()).extensionConfig.lark.runInApp, false)
  assert.equal((await disk()).extensions, undefined)
  await themes(page, 'lark-settings-off')
  await submit('Does Local still work?')
  await page.getByText('Local answer', { exact: true }).nth(2).waitFor()
  await page.waitForFunction(
    async () =>
      !(await window.vela.sessions('local')).some(
        (s) => s.state === 'running' || s.state === 'queued',
      ),
  )
  await open()
  await toggle.click()
  await connected.waitFor()
  const release = hold()
  try {
    await submit('Keep this session running')
    await page.waitForFunction(async () =>
      (await window.vela.sessions('local')).some((s) => s.state === 'running'),
    )
    await open()
    await toggle.click()
    await page
      .getByRole('alert')
      .filter({ hasText: 'A session is still running' })
      .waitFor()
    assert.equal(await toggle.isChecked(), true)
    assert.equal((await disk()).extensionConfig.lark.runInApp, true)
  } finally {
    release()
  }
  await page.waitForFunction(
    async () =>
      !(await window.vela.sessions('local')).some(
        (s) => s.state === 'running' || s.state === 'queued',
      ),
  )
  await page.getByRole('button', { name: 'Remove oc_settings' }).click()
  await page.getByText('No enabled chats.', { exact: true }).waitFor()
  const saved = (await disk()).extensionConfig.lark
  assert.deepEqual(saved.chats, [])
  assert(
    saved.appId === 'verify-app' &&
      saved.appSecret === secret &&
      saved.runInApp === true,
  )
  assert.equal(
    (await page.evaluate(() => window.vela.projects())).some(
      (p) => p.cwd === project,
    ),
    true,
  )
}

export async function seedLarkChat(dir: string, secret: string) {
  const path = join(dir, 'settings.json')
  const settings = JSON.parse(await readFile(path, 'utf8'))
  settings.extensionConfig = {
    lark: {
      appId: 'not-configured',
      appSecret: secret,
      chats: [
        'oc_duplicate',
        'oc_duplicate',
        { id: 'oc_settings', readUntagged: false },
      ],
    },
  }
  await writeFile(path, JSON.stringify(settings))
}
