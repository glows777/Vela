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
  await waitForLocalWork(page, false)
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
  await waitForState(
    () => page.evaluate(async () => (await window.vela.settings()).lark.loaded),
    'Lark did not load',
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
  await waitForLocalWork(page, false)
  await open()
  await toggle.click()
  await connected.waitFor()
  const release = hold()
  try {
    await submit('Keep this session running')
    await waitForLocalWork(page, true)
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
  await waitForLocalWork(page, false)
  await page.getByRole('button', { name: 'Remove oc_settings' }).click()
  await page.getByText('No enabled chats.', { exact: true }).waitFor()
  const saved = (await disk()).extensionConfig.lark
  assert.deepEqual(saved.chats, [])
  assert(
    saved.appId === 'verify-app' &&
      saved.appSecret === secret &&
      saved.runInApp === true,
  )
  await pendingCredentialJourney(page, dir, `${secret}-rotation`, submit)
  assert(
    (await disk()).extensionConfig.lark.appSecret === `${secret}-rotation`,
    'The later credential edit remains saved',
  )
  await open()
  const invalidDataDir = join(dir, 'unavailable-storage')
  await writeFile(invalidDataDir, 'a file cannot be used as a data directory')
  const original = await disk()
  await writeFile(
    path,
    JSON.stringify({ ...original, dataDir: invalidDataDir }),
  )
  try {
    await toggle.click()
    const diagnostic = page
      .getByRole('alert')
      .filter({ hasText: /check.*data directory/i })
    await diagnostic.waitFor({ timeout: 5000 })
    assert(!(await diagnostic.innerText()).includes(invalidDataDir))
    await themes(page, 'lark-settings-replacement-error')
    assert.deepEqual(
      await page.evaluate(async () =>
        (await window.vela.channels()).map(({ name }) => name),
      ),
      ['local'],
    )
    await verifyReply(
      page,
      submit,
      'Can Local answer after the replacement failed?',
    )
  } finally {
    const repaired = await disk()
    delete repaired.dataDir
    await writeFile(path, JSON.stringify(repaired))
  }
  await open()
  await toggle.click()
  await connected.waitFor()
  assert.equal(
    (await page.evaluate(() => window.vela.projects())).some(
      (p) => p.cwd === project,
    ),
    true,
  )
  return [
    'A duplicate enabled chat at startup shows the setting to fix; Local answers, and turning ownership off clears the diagnostic.',
    'Lark settings verify credentials, hide both secrets, disconnect and reconnect the desktop host, protect a running Local session, and remove an enabled chat.',
    'While a credential check is pending, Local answers and another credential edit succeeds. The stale check cannot overwrite that edit.',
    'When the replacement cannot use the configured data directory, Settings gives a repair instruction, Local answers, and the repaired host reconnects.',
  ]
}

async function waitForState(check: () => Promise<boolean>, failure: string) {
  const deadline = Date.now() + 10_000
  while (!(await check())) {
    assert(Date.now() < deadline, failure)
    await Bun.sleep(50)
  }
}

function waitForLocalWork(page: Page, busy: boolean) {
  return waitForState(
    () =>
      page.evaluate(async (expected) => {
        const sessions = await window.vela.sessions('local')
        return (
          sessions.some(
            (s) => s.state === 'running' || s.state === 'queued',
          ) === expected
        )
      }, busy),
    `Local did not become ${busy ? 'busy' : 'idle'}`,
  )
}

async function verifyReply(
  page: Page,
  submit: (text: string) => Promise<void>,
  message: string,
) {
  await submit(message)
  const chat = page.getByLabel('Project chat')
  const submitted = chat
    .locator('[data-role="user"]')
    .filter({ hasText: message })
  await submitted
    .locator('+ [data-role="assistant"]')
    .getByText('Local answer', { exact: true })
    .waitFor({ timeout: 5000 })
  await waitForLocalWork(page, false)
}

/** Hold a fake token request while the same window sends and reads a real Local reply. */
async function pendingCredentialJourney(
  page: Page,
  dir: string,
  rotatedSecret: string,
  submit: (text: string) => Promise<void>,
) {
  const attempt = page.evaluate(async () => {
    try {
      await window.vela.saveLark({ appId: 'verify-held' })
      return 'Saved'
    } catch (error) {
      return String(error)
    }
  })
  try {
    const deadline = Date.now() + 10_000
    while (!(await Bun.file(join(dir, 'verification-started')).exists())) {
      assert(Date.now() < deadline, 'The fake credential check did not start')
      await Bun.sleep(50)
    }
    await verifyReply(
      page,
      submit,
      'Can Local answer before credential validation finishes?',
    )
    // A second credential edit wins while the first is still verifying the old saved secret.
    await page.evaluate(
      (appSecret) => window.vela.saveLark({ appId: 'verify-app', appSecret }),
      rotatedSecret,
    )
  } finally {
    await writeFile(join(dir, 'release-verification'), '')
    await attempt
  }
  assert.match(await attempt, /credentials changed during verification/i)
  assert.equal(
    (await page.evaluate(() => window.vela.settings())).lark.appId,
    'verify-app',
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
