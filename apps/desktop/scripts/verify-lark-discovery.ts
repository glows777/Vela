import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright'

// A bridge read is asynchronous. Playwright's DOM predicate checks the returned
// promise for truthiness, so poll the value after the IPC reply instead.
async function waitForBridge(page: Page, read: () => Promise<unknown>) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await page.evaluate(read)) return
    await Bun.sleep(50)
  }
  throw new Error(`Timed out waiting for the bridge: ${read}`)
}

/** A separate host, transport, scenario and settings file from the Lark history journeys. */
export async function verifyLarkDiscovery(
  scratch: string,
  launch: (
    env: Record<string, string>,
  ) => Promise<{ page: Page; close(): Promise<void> }>,
  themes: (page: Page, name: string) => Promise<void>,
  send: (page: Page, label: string, text: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(scratch, 'group-setup-'))
  const transport = join(dir, 'transport')
  const discovery = join(transport, 'discovery')
  await mkdir(discovery, { recursive: true })
  const settings = join(dir, 'settings.json')
  const oldChat = 'oc_enabled'
  await Bun.write(
    settings,
    JSON.stringify({ extensionConfig: { lark: { chats: [] } } }),
  )
  await Bun.write(
    join(transport, 'seed.json'),
    JSON.stringify({
      chats: {
        oc_enabled: { name: 'Enabled group' },
        oc_new: { name: 'New group' },
      },
    }),
  )
  const scenario = join(dir, 'faux.json')
  await Bun.write(
    scenario,
    JSON.stringify({
      generate: [{ text: 'Compacted history' }],
      responses: [
        { text: 'Still listening during confirmation.' },
        { text: 'Group answer after cancel.' },
        { text: 'Incoming mention received.' },
        { text: 'Local answer after cancel.' },
        { hang: true },
      ],
    }),
  )
  const app = await launch({
    VELA_DIR: dir,
    VELA_MODEL: `faux:${scenario}`,
    VELA_DESKTOP_LARK: 'fake',
    VELA_DESKTOP_LARK_DIR: transport,
    GROUP_SETUP_CHAT: 'oc_enabled',
    LARK_APP_ID: 'cli_desktop_fake',
    LARK_APP_SECRET: 'test-only',
  })
  try {
    const { page } = app
    await page.goto(new URL('index.html', page.url()).href)
    await page.setViewportSize({ width: 800, height: 600 })
    const sidebar = page.getByLabel('Sidebar')
    const dialog = page.getByRole('dialog')
    const open = async () => {
      await sidebar.getByRole('button', { name: 'New project' }).click()
      await dialog.getByRole('tab', { name: 'Lark' }).click()
    }
    const add = dialog.getByRole('button', { name: 'Add a group' })
    const mention = (chatId = 'oc_new') =>
      appendFile(
        join(discovery, 'control.jsonl'),
        `${JSON.stringify({
          op: 'say',
          chatId,
          text: 'Enable this group',
        })}\n`,
      )
    await open()
    assert.equal(
      await dialog.getByRole('button', { name: 'Enabled group' }).count(),
      0,
    )
    await add.click()
    await mention(oldChat)
    await dialog.getByRole('button', { name: 'Enable group' }).click()
    await sidebar.getByRole('button', { name: 'Enabled group Lark' }).waitFor()
    const original = await readFile(settings, 'utf8')
    assert.deepEqual(JSON.parse(original).extensionConfig.lark.chats, [oldChat])
    await Bun.write(join(discovery, 'control.jsonl'), '')
    await open()
    await dialog.getByRole('button', { name: 'Enabled group' }).waitFor()
    assert.equal(await dialog.getByText('New group').count(), 0)
    await themes(page, 'lark-new-project-groups')
    if (process.env.VELA_DESKTOP_VERIFY_DISCOVERY_TIMEOUT === '1') {
      await add.click()
      await mention(oldChat)
      await dialog
        .getByRole('alert')
        .filter({ hasText: /No group mention received/ })
        .waitFor({ timeout: 150_000 })
      assert.equal(await readFile(settings, 'utf8'), original)
      assert(
        (await page.evaluate(() => window.vela.connection('lark'))).connected,
      )
    }
    await add.click()
    await dialog
      .getByRole('status')
      .filter({ hasText: /Local and Lark are paused/ })
      .waitFor()
    await dialog
      .getByText(/won’t answer messages sent to enabled groups/)
      .waitFor()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    assert.equal(await readFile(settings, 'utf8'), original)
    await add.click()
    await mention(oldChat)
    await mention()
    await dialog.getByRole('button', { name: 'Enable group' }).waitFor()
    assert.equal(
      await dialog.getByText(oldChat, { exact: true }).count(),
      0,
      'A mention from the already enabled group must not become the approval candidate',
    )
    assert.equal(await dialog.getByLabel('Lark group ID').innerText(), 'oc_new')
    assert.equal(await readFile(settings, 'utf8'), original)
    await dialog.getByText(/only if the ID matches/).waitFor()
    await dialog.getByText(/running commands on this computer/).waitFor()
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[role="dialog"]')!
      const button = Array.from(dialog.querySelectorAll('button')).find(
        (item) => item.textContent === 'Enable group',
      )
      return (
        button &&
        button.getBoundingClientRect().bottom <=
          dialog.getBoundingClientRect().bottom
      )
    })
    await themes(page, 'lark-new-project-confirm')
    // Existing groups keep receiving and answering while the person decides.
    await appendFile(
      join(transport, 'control.jsonl'),
      `${JSON.stringify({
        op: 'say',
        chatId: oldChat,
        text: 'Are you listening?',
        senderName: 'Mira',
      })}\n`,
    )
    await waitForBridge(page, async () => {
      const project = (await window.vela.projects()).find(
        (p) => p.id === 'oc_enabled',
      )
      if (!project) return false
      const history = await window.vela.larkMessages({
        chatId: project.id,
        sessionId: project.sessionId,
      })
      return history.messages.some(
        (message) => message.text === 'Still listening during confirmation.',
      )
    })
    await waitForBridge(
      page,
      async () => !(await window.vela.sessions('lark')).some((s) => s.runId),
    )
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await add.waitFor()
    assert.equal(await readFile(settings, 'utf8'), original)
    await Bun.write(join(discovery, 'control.jsonl'), '')
    await dialog.getByRole('button', { name: 'Enabled group' }).click()
    await page.getByRole('button', { name: 'Close sessions' }).click()
    await send(
      page,
      'Message Vela in this group',
      'Can the group still answer?',
    )
    await page
      .getByLabel('Project chat')
      .getByText('Group answer after cancel.', { exact: true })
      .waitFor()
    await appendFile(
      join(transport, 'control.jsonl'),
      `${JSON.stringify({
        op: 'say',
        chatId: 'oc_enabled',
        text: 'Is the bot listening again?',
        senderName: 'Mira',
      })}\n`,
    )
    await page
      .getByLabel('Project chat')
      .getByText('Incoming mention received.', { exact: true })
      .waitFor()
    await Bun.write(join(transport, 'control.jsonl'), '')
    await sidebar.getByRole('button', { name: 'New project' }).click()
    await dialog.getByLabel('Folder path').fill(dir)
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await send(page, 'Message Vela in this project', 'Does Local still work?')
    await page
      .getByText('Local answer after cancel.', { exact: true })
      .waitFor()

    await send(page, 'Message Vela in this project', 'Keep this run active')
    await waitForBridge(page, async () =>
      (await window.vela.sessions('local')).find((s) => s.runId),
    )
    await open()
    await add.click()
    await dialog
      .getByRole('alert')
      .filter({ hasText: /stop|finish/i })
      .waitFor()
    assert.equal(await readFile(settings, 'utf8'), original)
    assert(
      await page.evaluate(async () => {
        const active = (await window.vela.sessions('local')).find(
          (s) => s.runId,
        )
        return (
          active?.runId &&
          (await window.vela.stop(
            'local',
            { chatId: active.chatId },
            active.runId,
          ))
        )
      }),
    )
    await waitForBridge(
      page,
      async () => !(await window.vela.sessions('local')).some((s) => s.runId),
    )
    // The host is live during confirmation. A run started there also vetoes a save.
    await Bun.write(scenario, JSON.stringify({ responses: [{ hang: true }] }))
    await add.click()
    await mention()
    await dialog.getByRole('button', { name: 'Enable group' }).waitFor()
    await Bun.write(
      join(transport, 'control.jsonl'),
      `${JSON.stringify({
        op: 'say',
        chatId: oldChat,
        text: 'Keep the group busy',
        senderName: 'Mira',
      })}\n`,
    )
    await waitForBridge(page, async () =>
      (await window.vela.sessions('lark')).find((s) => s.runId),
    )
    await dialog.getByRole('button', { name: 'Enable group' }).click()
    await dialog
      .getByRole('alert')
      .filter({ hasText: /stop|finish/i })
      .waitFor()
    assert.equal(await readFile(settings, 'utf8'), original)
    assert(
      await page.evaluate(async () => {
        const active = (await window.vela.sessions('lark')).find((s) => s.runId)
        return (
          active?.runId &&
          (await window.vela.stop(
            'lark',
            { chatId: active.chatId },
            active.runId,
          ))
        )
      }),
    )
    await waitForBridge(
      page,
      async () => !(await window.vela.sessions('lark')).some((s) => s.runId),
    )
    await Bun.write(join(transport, 'control.jsonl'), '')
    await Bun.write(join(discovery, 'control.jsonl'), '')
    // The shared helper refuses to rewrite an environment expression. The original
    // group remains active when the host comes back, and the dialog can retry.
    const expression = JSON.stringify({
      extensionConfig: { lark: { chats: '$GROUP_SETUP_CHAT' } },
    })
    await Bun.write(settings, expression)
    await add.click()
    await mention()
    await dialog.getByText(/Every member/).waitFor()
    await dialog.getByRole('button', { name: 'Enable group' }).click()
    await dialog
      .getByRole('alert')
      .filter({ hasText: /environment expression/ })
      .waitFor()
    assert.equal(await readFile(settings, 'utf8'), expression)
    assert(
      (await page.evaluate(() => window.vela.projects())).some(
        (p) => p.id === 'oc_enabled',
      ),
    )
    await Bun.write(settings, original)
    await Bun.write(join(discovery, 'control.jsonl'), '')
    await add.click()
    await mention()
    await dialog.getByText(/Every member/).waitFor()
    assert.equal(await readFile(settings, 'utf8'), original)
    await dialog.getByRole('button', { name: 'Enable group' }).click()
    await sidebar.getByRole('button', { name: 'New group Lark' }).waitFor()
    await page
      .getByRole('heading', { name: 'New group', exact: true })
      .waitFor()
    assert.deepEqual(
      JSON.parse(await readFile(settings, 'utf8')).extensionConfig.lark.chats,
      [oldChat, 'oc_new'],
    )
    await themes(page, 'lark-new-project-added')
  } finally {
    await app.close()
  }
}
