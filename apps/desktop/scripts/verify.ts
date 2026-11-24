import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  _electron,
  chromium,
  type ElectronApplication,
  type Page,
} from 'playwright'
import tokens from '../design/tokens.json'
import type { DesktopBridge } from '../src/shared/bridge.ts'
import { verifyControls } from './verify-controls.ts'
import { verifyLarkDiscovery } from './verify-lark-discovery.ts'
import { seedLarkChat, verifyLarkSettings } from './verify-lark-settings.ts'
import { GOOD_KEY, startVerifyProvider } from './verify-provider.ts'

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
/** First run and the Lark journeys each need a data directory of their own. */
let firstRunData: string | undefined
let larkData: string | undefined
let larkOffData: string | undefined
const profile = resolve(scratch, 'user-data')
const project = resolve(scratch, 'project')
const alpha = resolve(scratch, 'alpha')
const beta = resolve(scratch, 'beta')
const gamma = resolve(scratch, 'gamma')
const larkWorkspace = resolve(scratch, 'lark-local')
const scenario = resolve(scratch, 'faux.json')
const larkScenario = resolve(scratch, 'lark-faux.json')
const larkOffScenario = resolve(scratch, 'lark-off-faux.json')
/** The fake Lark's seed history and the person's scripted messages. */
const larkDir = resolve(scratch, 'lark')
async function pick(
  page: Page,
  trigger: ReturnType<Page['getByRole']>,
  label: string,
) {
  await trigger.click()
  await page
    .getByRole('listbox')
    .getByRole('option', { name: label, exact: true })
    .click()
  assert.equal(await page.locator('select').count(), 0)
}

const larkProject = 'oc_alpha'
const reasoningModel = 'gpt-5.4'
/** A second enabled group, for the history gap a long disconnect leaves. */
const gapProject = 'oc_gap'
/** A third, busy group: routine live messages must not reset paging. */
const liveProject = 'oc_live'
/** A fourth group: a filtered page sits inside the gap a long absence leaves. */
const jumpProject = 'oc_jump'
/** A group nobody has written in yet. */
const emptyProject = 'oc_empty'
/** A group whose first read the fake refuses, as a dropped connection would. */
const denyProject = 'oc_deny'
/** A busy group: paging and a refresh can overlap. */
const raceProject = 'oc_race'
const shell = resolve(scratch, 'shell')
const shellMarker = resolve(scratch, 'shell-used')
const badConfig = process.env.VELA_DESKTOP_VERIFY_BAD_CONFIG === '1'
const disabledConfig = process.env.VELA_DESKTOP_VERIFY_DISABLED === '1'
/** A saved model whose provider is gone: setup must open, not Home. */
const staleModel = process.env.VELA_DESKTOP_VERIFY_STALE_MODEL === '1'
/** An auth.json Vela cannot read: the window must say so instead of staying blank. */
const brokenAuth = process.env.VELA_DESKTOP_VERIFY_BROKEN_AUTH === '1'
await Promise.all(
  [
    home,
    data,
    profile,
    project,
    alpha,
    beta,
    gamma,
    larkWorkspace,
    larkDir,
  ].map((path) => mkdir(path, { recursive: true })),
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
        ...(staleModel ? { defaultModel: 'removed-provider/some-model' } : {}),
      }),
)
if (brokenAuth) await Bun.write(resolve(data, 'auth.json'), '{ not json')
await Bun.write(
  scenario,
  JSON.stringify({
    // Steps play in order, so every journey waits for a session to be idle before its
    // next input. A hand-off costs three: the hub's tool call, the hub's suppressed
    // reply and the new session's first answer.
    responses: [
      // Bridge journey and journey 1.
      {
        toolCalls: [{ name: 'bash', input: { command: 'printf shell-check' } }],
      },
      { text: 'Desktop faux reply' },
      { text: 'Image processed' },
      {
        text: [
          'Alpha answer',
          '',
          '## Summary',
          '',
          '- **Found** the `index.ts` file',
          '- *Ready* to go',
          '',
          '> A note',
          '',
          '| File | Status |',
          '| --- | --- |',
          '| index.ts | Ready |',
          '',
          '```ts',
          'const answer = 42',
          '```',
          '',
          '[Reference](https://example.com/docs) · [Email](mailto:demo@example.com)',
          '',
          '<b>Plain HTML example</b>',
          '',
          '![Remote illustration](https://example.com/image.png)',
        ].join('\n'),
      },
      { text: 'Second answer' },
      // Journey 2: bigger work in a session, stopped, continued, failed, then asked a
      // question that journey 3 answers in the same session.
      {
        toolCalls: [
          {
            name: 'channel_start_topic',
            input: {
              title: 'Fix the retry backoff',
              brief:
                'Fix the retry backoff in src/agent/retry.ts and add a test.',
            },
          },
        ],
      },
      // The hub's reply after the tool result and the session's first answer race for
      // the next step, and the hub's is suppressed on hand-off: same text either way.
      { text: 'I will read the retry module first.' },
      { text: 'I will read the retry module first.' },
      { toolCalls: [{ name: 'bash', input: { command: 'printf retry' } }] },
      { hang: true },
      { text: 'Continued after the stop.' },
      { error: 'invalid api key' },
      {
        toolCalls: [
          {
            name: 'channel_wait_for_input',
            input: { reason: 'Which colour should I use?' },
          },
        ],
      },
      { text: 'Which colour should I use?' },
      { text: 'Blue it is.' },
      // Journey 4: a second project with its own session, then a long answer that
      // fills Alpha's chat.
      { text: 'Beta answer' },
      {
        toolCalls: [
          {
            name: 'channel_start_topic',
            input: {
              title: 'Write the Beta notes',
              brief: 'Write notes about this folder.',
            },
          },
        ],
      },
      { text: 'Reading the folder now.' },
      { text: 'Reading the folder now.' },
      {
        text: Array.from(
          { length: 40 },
          (_, index) => `Paragraph ${index + 1} of a long answer from Vela.`,
        ).join('\n\n'),
      },
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
const journeyOne = async (page: Page, app?: ElectronApplication) => {
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
  checks.push(
    'New project asks for a folder and a name, and cannot be submitted while the folder is empty.',
  )
  await dialog
    .getByLabel('Folder path')
    .fill(resolve(scratch, 'no-such-folder'))
  await create.click()
  const folderAlert = dialog.getByRole('alert')
  await folderAlert.waitFor()
  const folderReason = (await folderAlert.textContent()) ?? ''
  assert.equal(folderReason, 'Project must be an existing directory')
  await themes(page, 'journey-1-rejected-folder')
  checks.push(
    "A folder that does not exist is refused with the host's own reason.",
  )
  await dialog.getByLabel('Folder path').fill(alpha)
  await dialog.getByLabel('Name').fill('Alpha')
  await create.click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByRole('heading', { name: 'Alpha', exact: true }).waitFor()
  const header = page.getByRole('banner')
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

  const shortcut = process.platform === 'darwin' ? 'Meta+n' : 'Control+n'
  await sidebar.getByRole('button', { name: 'New project' }).click()
  await dialog.getByLabel('Folder path').waitFor()
  await page.keyboard.press(shortcut)
  await dialog.getByLabel('Folder path').waitFor()
  await dialog.getByRole('button', { name: 'Close dialog' }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByRole('heading', { name: 'Alpha', exact: true }).waitFor()
  const shortcutComposer = page.getByRole('textbox', {
    name: 'Message Vela',
    exact: true,
  })
  const focus = () => shortcutComposer.and(page.locator(':focus')).waitFor()
  await page.keyboard.press(shortcut)
  await focus()
  await sidebar.getByRole('button', { name: 'Alpha Local' }).click()
  await sidebar.getByRole('button', { name: 'New session' }).click()
  await focus()
  checks.push(
    'The shortcut and sidebar focus the Home composer, without leaving an open modal.',
  )
  await sidebar.getByRole('button', { name: 'Alpha Local' }).click()

  const composer = page.getByLabel('Message Vela in this project')
  const height = () => composer.evaluate((node) => node.clientHeight)
  const initialHeight = await height()
  await composer.fill('One\nTwo\nThree\nFour')
  assert(
    (await height()) > initialHeight,
    'The composer grows with multiple lines',
  )
  await composer.fill(Array.from({ length: 40 }, () => 'Line').join('\n'))
  assert(
    await composer.evaluate((node) => node.scrollHeight > node.clientHeight),
  )
  const question = 'What does this project contain?\n**Keep this literal**'
  await composer.fill(question)
  await page.getByRole('button', { name: 'Send' }).click()
  await page.getByText(question, { exact: true }).waitFor()
  const bubble = page.locator('[data-role="user"]')
  assert.equal(await bubble.locator('p').textContent(), question)
  assert.equal(await bubble.locator('strong').count(), 0)
  checks.push("The person's message remains a plain-text bubble with newlines.")

  await page
    .getByText('Alpha answer', { exact: true })
    .waitFor({ timeout: 30_000 })
  assert.equal(
    await page
      .locator('[data-role="user"]')
      .getByText(question, { exact: true })
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
    await height(),
    initialHeight,
    'The composer resets after sending',
  )
  assert.equal(
    await page.evaluate(() =>
      document
        .querySelector('[aria-label="Project chat"]')
        ?.lastElementChild?.getAttribute('data-role'),
    ),
    'assistant',
  )
  const answer = page.locator('[data-role="assistant"]').last()
  await answer.getByRole('heading', { name: 'Summary' }).waitFor()
  await answer.getByRole('list').getByText('Found', { exact: true }).waitFor()
  await answer.locator('li code').filter({ hasText: 'index.ts' }).waitFor()
  await answer.locator('blockquote').getByText('A note').waitFor()
  await answer.getByRole('table').getByRole('cell', { name: 'Ready' }).waitFor()
  assert.equal(
    await answer.getByRole('link', { name: 'Reference' }).getAttribute('href'),
    'https://example.com/docs',
  )
  assert.equal(await answer.getByRole('link', { name: 'Email' }).count(), 0)
  assert.equal(await answer.locator('img, b').count(), 0)
  await assert.rejects(
    page.evaluate(() => window.vela.openMessageLink('mailto:demo@example.com')),
    /Only HTTP and HTTPS/,
  )
  await answer.getByRole('button', { name: 'Copy', exact: true }).click()
  await answer.getByRole('button', { name: 'Copied', exact: true }).waitFor()
  if (app)
    assert.equal(
      await app.evaluate(({ clipboard }) => clipboard.readText()),
      'const answer = 42',
    )
  checks.push(
    'Vela renders Markdown, copies code, excludes non-web links, raw HTML and images, and keeps the answer as the last turn.',
  )

  await page.reload()
  await page.getByRole('heading', { name: 'VELA', exact: true }).waitFor()
  await page
    .getByLabel('Sidebar')
    .getByRole('button', { name: 'Alpha Local' })
    .click()
  await page.getByText(question, { exact: true }).waitFor()
  await page.getByText('Alpha answer', { exact: true }).waitFor()
  checks.push(
    'After a reload the project and both messages come back from recorded history.',
  )

  const alphaProject = await projectNamed(page, 'Alpha')
  await waitForIdle(page, alphaProject.sessionId)
  await page.getByRole('button', { name: 'Home', exact: true }).click()
  assert.equal(
    await page
      .getByRole('combobox', { name: 'Project', exact: true })
      .textContent(),
    'Alpha · Local',
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

  // A real rejected submission: Local refuses text over 100000 characters, so the
  // host rejects it before anything is recorded.
  const projectComposer = page.getByLabel('Message Vela in this project')
  const bubbles = await page.locator('[data-role="user"]').count()
  const tooLong = 'x'.repeat(100_001)
  await projectComposer.fill(tooLong)
  await page.getByRole('button', { name: 'Send' }).click()
  const tooLongAlert = page.getByRole('alert')
  await tooLongAlert.waitFor()
  const tooLongReason = (await tooLongAlert.textContent()) ?? ''
  assert.equal(tooLongReason, 'Message is too long (max 100000 characters)')
  assert.equal(
    (await projectComposer.inputValue()).length,
    tooLong.length,
    'A rejected draft comes back',
  )
  assert.equal(
    await page.locator('[data-role="user"]').count(),
    bubbles,
    'A rejected draft leaves no message behind',
  )
  checks.push(
    'A submission the host rejects shows the reason in words a person can act on, restores the draft and records no message.',
  )
  await page.getByRole('button', { name: 'Dismiss error' }).click()
  await tooLongAlert.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Send' }).click()
  await tooLongAlert.waitFor()
  await sidebar.getByRole('button', { name: 'Home', exact: true }).click()
  await tooLongAlert.waitFor({ state: 'hidden' })
  await sidebar.getByRole('button', { name: 'Alpha Local' }).click()
  await projectComposer.waitFor()
  await tooLongAlert.waitFor({ state: 'hidden' })
  checks.push('A transient error can be dismissed and is gone on navigation.')
  await projectComposer.fill('')

  const hint = page.getByText(/on this computer/)
  await hint.waitFor()
  assert(
    (await hint.textContent())?.includes(alpha),
    'The composer names the folder where Vela runs',
  )
  await noOverflow(page)
  await themes(page, 'journey-1')
  checks.push(
    'The composer names the folder where Vela runs, in light and dark, with no horizontal overflow.',
  )
  await longPathHeader(page)
  await longNameHeader(page)
}

/** The 44px header's name, tag and folder, as the layout resolved them. */
const headerLayout = (page: Page, cwd: string) =>
  page.getByRole('banner').evaluate((bar, cwd) => {
    const title = bar.querySelector('h2')!
    const path = [...bar.querySelectorAll('span')].find(
      (span) => span.textContent === cwd,
    )!
    const lines = document.createRange()
    lines.selectNodeContents(title)
    return {
      name: title.textContent,
      lines: new Set([...lines.getClientRects()].map(({ top }) => top)).size,
      titleClipped: title.scrollWidth > title.clientWidth,
      textOverflow: getComputedStyle(path).textOverflow,
      clipped: path.scrollWidth > path.clientWidth,
      hover: path.title,
    }
  }, cwd)

/**
 * A folder nested deep enough that its path cannot fit the 44px header. The scratch
 * prefix differs by platform (`/var/folders/…` on macOS, `/tmp` on Linux), so the
 * nesting grows until the whole path reaches the ~200 characters the issue reproduced
 * with rather than relying on a fixed suffix that a short prefix would undercut.
 */
const deepFolder = () => {
  const segments = [
    'clients',
    'northwind-retail',
    'platform-migration',
    'services',
    'billing',
    'legacy-importer',
    'fixtures',
    '2026-08-nightly',
    'snapshots',
    '2026-08-19',
    'tenant-northwind-eu-west-1',
    'original',
    'transcripts',
  ]
  let path = resolve(scratch, ...segments)
  for (let n = 1; path.length < 200; n += 1) {
    segments.push(`archive-${n}`)
    path = resolve(scratch, ...segments)
  }
  return path
}

/**
 * Journey 1's last step: a folder nested ~200 characters deep. The path shares the
 * 44px header with the project name, so it must ellipsize rather than squeeze the
 * name onto two lines (#470). The document-level overflow check alone missed that.
 */
const longPathHeader = async (page: Page) => {
  const sidebar = page.getByLabel('Sidebar')
  const longPath = deepFolder()
  await mkdir(longPath, { recursive: true })
  await sidebar.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Folder path').fill(longPath)
  await dialog.getByLabel('Name').fill('Long path')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page
    .getByRole('banner')
    .getByRole('heading', { name: 'Long path' })
    .waitFor()

  for (const { name, width, height } of [
    { name: 'wide', width: 1280, height: 800 },
    { name: 'minimum', width: 800, height: 600 },
  ]) {
    await page.setViewportSize({ width, height })
    const header = await headerLayout(page, longPath)
    assert.equal(header.name, 'Long path')
    assert.equal(
      header.lines,
      1,
      `The project name stays on one line at ${width}×${height}`,
    )
    assert(!header.titleClipped, 'The short title remains fully visible')
    assert.equal(
      header.textOverflow,
      'ellipsis',
      `The folder path ellipsizes at ${width}×${height}`,
    )
    assert(
      header.clipped,
      `The long folder path is clipped at ${width}×${height}`,
    )
    assert.equal(
      header.hover,
      longPath,
      'The path names the whole folder when hovered',
    )
    await noOverflow(page)
    await themes(page, `journey-1-long-path-${name}`)
  }

  await page.setViewportSize({ width: 1280, height: 800 })
  await sidebar.getByRole('button', { name: 'Alpha Local' }).click()
  await page.getByRole('heading', { name: 'Alpha', exact: true }).waitFor()
  checks.push(
    'A long folder path ellipsizes in the header while the project name stays on one line, at 800×600 and wider.',
  )
}
/** A long name must not push the project tag or folder out of the header. */
const longNameHeader = async (page: Page) => {
  const name =
    'Northwind Retail Platform Migration Planning Workspace for European Tenants'
  const folder = resolve(scratch, 'short')
  await mkdir(folder, { recursive: true })
  const sidebar = page.getByLabel('Sidebar')
  await sidebar.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Folder path').fill(folder)
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await dialog.waitFor({ state: 'hidden' })

  await page.setViewportSize({ width: 800, height: 600 })
  const bar = page.getByRole('banner')
  await bar.getByRole('heading', { name, exact: true }).waitFor()
  const layout = await bar.evaluate((bar, folder) => {
    const title = bar.querySelector('h2')!
    const spans = [...bar.querySelectorAll('span')]
    const tag = spans.find((span) => span.textContent === 'Local')!
    const path = spans.find((span) => span.textContent === folder)!
    const range = document.createRange()
    range.selectNodeContents(title)
    const barBox = bar.getBoundingClientRect()
    return {
      lines: new Set([...range.getClientRects()].map(({ top }) => top)).size,
      ellipsis: getComputedStyle(title).textOverflow,
      titleOverflow: getComputedStyle(title).overflowX,
      clipped: title.scrollWidth > title.clientWidth,
      overflow: bar.scrollWidth > bar.clientWidth,
      inside: [title, tag, path].every((element) => {
        const box = element.getBoundingClientRect()
        return (
          box.width > 0 &&
          box.left >= barBox.left &&
          box.right <= Math.min(barBox.right, innerWidth)
        )
      }),
    }
  }, folder)
  assert.deepEqual(layout, {
    lines: 1,
    ellipsis: 'ellipsis',
    titleOverflow: 'hidden',
    clipped: true,
    overflow: false,
    inside: true,
  })
  await noOverflow(page)
  await themes(page, 'journey-1-long-name-minimum')

  await page.setViewportSize({ width: 1280, height: 800 })
  await sidebar.getByRole('button', { name: 'Alpha Local' }).click()
  await page.getByRole('heading', { name: 'Alpha', exact: true }).waitFor()
  checks.push(
    'A long name ellipsizes on one line at 800×600 without pushing the tag or folder out of the header.',
  )
}

/** The same screen in light and dark, each once the tokens have switched. */
const themes = async (page: Page, name: string) => {
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
  await snapshot(page, `${name}-light`)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForFunction(
    (expected) =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--vela-ink')
        .trim() === expected,
    tokens.tokens['vela-ink'].dark,
  )
  await snapshot(page, `${name}-dark`)
  await page.emulateMedia({ colorScheme: null })
}

/** A session's card in the project chat; the panel may show the same title. */
const cardIn = (page: Page, title: string) =>
  page
    .getByLabel('Project chat')
    .getByRole('button', { name: new RegExp(`Session, ${title}`) })

/** Types into the composer with this label and sends; both composers can be on screen. */
const sendIn = async (page: Page, label: string, text: string) => {
  const form = page.locator('form').filter({ has: page.getByLabel(label) })
  await form.getByLabel(label).fill(text)
  await form.getByRole('button', { name: 'Send' }).click()
}

/**
 * Waits until a session has no live run. Input sent during a run steers it instead
 * of starting a new one, which is right for a person and wrong for a scripted queue.
 */
const waitForIdle = async (
  page: Page,
  sessionId: string,
  timeout = 30_000,
  channel = 'local',
) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const sessions = await page.evaluate(
      (channel) => window.vela.sessions(channel),
      channel,
    )
    const session = sessions.find((item) => item.sessionId === sessionId)
    if (
      session &&
      !session.runId &&
      session.state !== 'running' &&
      session.state !== 'queued'
    )
      return session
    await Bun.sleep(50)
  }
  throw new Error(`Session ${sessionId} never settled`)
}

/** The Local project the sidebar lists under this name. */
const projectNamed = async (page: Page, name: string) => {
  const projects = await page.evaluate(() => window.vela.projects())
  const project = projects.find((item) => item.name === name)
  assert(project, `No project named ${name}`)
  return project
}

/** Waits for the recorded session to reach a state, which the window learns by event. */
const waitForSessionState = async (
  page: Page,
  projectId: string,
  task: string,
  state: string,
  timeout = 30_000,
  channel = 'local',
) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const sessions = await page.evaluate(
      ({ projectId, channel }) => window.vela.sessions(channel, projectId),
      { projectId, channel },
    )
    const session = sessions.find((item) => item.task === task)
    if (session?.state === state) return session
    await Bun.sleep(50)
  }
  throw new Error(`Session "${task}" never reached ${state}`)
}

/** Journey 2: bigger work in its card and panel; running, Stop, continue, then fail. */
const journeyTwo = async (page: Page) => {
  const alpha = await projectNamed(page, 'Alpha')
  const panel = page.getByRole('complementary', { name: 'Sessions' })
  await waitForIdle(page, alpha.sessionId)
  await panel.getByRole('heading', { name: 'Sessions', exact: true }).waitFor()

  await sendIn(
    page,
    'Message Vela in this project',
    'Fix the retry backoff in the agent and add a test',
  )

  const card = cardIn(page, 'Fix the retry backoff')
  await card.waitFor({ timeout: 30_000 })
  await card.getByText('Fix the retry backoff', { exact: true }).waitFor()
  checks.push(
    'Asking for bigger work shows a session card in the project chat.',
  )

  await card.click()
  const topic = (await waitForSessionState(
    page,
    alpha.id,
    'Fix the retry backoff',
    'done',
  ))!
  await panel.getByRole('button', { name: 'All sessions' }).waitFor()
  await panel
    .getByRole('heading', { name: 'Fix the retry backoff', exact: true })
    .waitFor()
  await panel
    .getByText('I will read the retry module first.', { exact: true })
    .waitFor({ timeout: 30_000 })
  checks.push(
    'The card opens that session in the panel, under Sessions › title, with its reply.',
  )

  await waitForIdle(page, topic.sessionId)
  await sendIn(page, 'Message in this session', 'Keep going')
  await waitForSessionState(page, alpha.id, 'Fix the retry backoff', 'running')
  await panel.getByText('bash', { exact: true }).waitFor({ timeout: 30_000 })
  await panel.getByRole('button', { name: 'Stop' }).waitFor()
  await panel.getByText('Running', { exact: true }).waitFor()
  checks.push('A running session shows one state word, the live tool and Stop.')

  await panel.getByRole('button', { name: 'Stop' }).click()
  await waitForSessionState(page, alpha.id, 'Fix the retry backoff', 'stopped')
  await waitForIdle(page, topic.sessionId)
  await panel.getByText('Stopped', { exact: true }).waitFor()
  assert.equal(await panel.getByRole('button', { name: 'Stop' }).count(), 0)
  checks.push(
    'Stop ends the run: the state word says Stopped and Stop is gone.',
  )

  await sendIn(page, 'Message in this session', 'Continue')
  await panel
    .getByText('Continued after the stop.', { exact: true })
    .waitFor({ timeout: 30_000 })
  await waitForSessionState(page, alpha.id, 'Fix the retry backoff', 'done')
  checks.push('A new message continues the stopped session and it finishes.')

  await waitForIdle(page, topic.sessionId)
  await sendIn(page, 'Message in this session', 'Now fail')
  const failure = panel.getByRole('alert')
  await failure.waitFor({ timeout: 30_000 })
  await failure
    .getByText('Vela stopped on an error.', { exact: true })
    .waitFor()
  assert(
    (await failure.textContent())?.includes('invalid api key'),
    'The card carries what the provider said',
  )
  // The topic's own status line repeats the failure for the group, so only the
  // recorded reply is meant to be hidden here.
  assert.equal(
    await panel
      .locator('[data-role="assistant"]')
      .getByText(/Check the error above/)
      .count(),
    0,
    'The reply the card repeats is hidden',
  )
  checks.push(
    'A failed run shows one error card and hides the reply that repeats it.',
  )

  await themes(page, 'journey-2')
  await page.setViewportSize({ width: 800, height: 600 })
  await noOverflow(page)
  await snapshot(page, 'journey-2-minimum')
  await page.setViewportSize({ width: 1280, height: 800 })
  checks.push(
    'The panel floats over the chat at 800px without overflowing the window.',
  )
}

/** Journey 3: a session that asks a question, from Home to the answer and back. */
const journeyThree = async (page: Page) => {
  const alpha = await projectNamed(page, 'Alpha')
  const panel = page.getByRole('complementary', { name: 'Sessions' })
  const topic = await waitForSessionState(
    page,
    alpha.id,
    'Fix the retry backoff',
    'done',
  )

  await panel.getByRole('button', { name: 'All sessions' }).click()
  await panel.getByRole('button', { name: /Fix the retry backoff/ }).click()
  await panel
    .getByRole('heading', { name: 'Fix the retry backoff', exact: true })
    .waitFor()
  await waitForIdle(page, topic.sessionId)
  await sendIn(page, 'Message in this session', 'Ask me which colour to use')

  // The failed run's card is gone once the next run starts, so its recorded reply
  // is back: the failure keeps exactly one visible record at a time.
  await panel
    .locator('[data-role="assistant"]')
    .getByText(/Task failed: invalid api key/)
    .waitFor({ timeout: 30_000 })
  checks.push(
    'Starting the next run drops the error card and shows the failed reply again.',
  )

  await waitForSessionState(page, alpha.id, 'Fix the retry backoff', 'waiting')
  await panel.getByText('Waiting for an answer', { exact: true }).waitFor()
  await panel
    .getByText('Which colour should I use?', { exact: true })
    .waitFor({ timeout: 30_000 })
  await page
    .getByRole('banner')
    .getByText('Waiting for you', { exact: true })
    .waitFor()
  checks.push(
    'A session that needs an answer shows Waiting for an answer, its question and the header label.',
  )
  await themes(page, 'journey-3')

  await panel.getByRole('button', { name: 'All sessions' }).click()
  await panel
    .getByRole('region', { name: 'Needs you' })
    .getByRole('button', { name: /Fix the retry backoff/ })
    .waitFor()
  checks.push('The panel lists it under Needs you.')

  // A question from Home must open the panel even when it was closed.
  await panel.getByRole('button', { name: 'Close sessions' }).click()
  await panel.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Home', exact: true }).click()
  const need = page.getByRole('button', {
    name: /Which colour should I use\?/,
  })
  await need.waitFor({ timeout: 30_000 })
  assert(
    (await need.textContent())?.includes('Alpha · Local'),
    'The row names its project and tag',
  )
  checks.push('Home leads with it under Needs you, naming its project and tag.')

  await need.click()
  await page.getByRole('heading', { name: 'Alpha', exact: true }).waitFor()
  await panel
    .getByRole('heading', { name: 'Fix the retry backoff', exact: true })
    .waitFor()
  checks.push('A question opened from Home reopens the panel on its session.')
  await waitForIdle(page, topic.sessionId)
  await sendIn(page, 'Message in this session', 'Blue')
  await panel
    .getByText('Blue it is.', { exact: true })
    .waitFor({ timeout: 30_000 })
  await waitForSessionState(page, alpha.id, 'Fix the retry backoff', 'done')
  checks.push('Answering in the panel clears the state and finishes the run.')

  await page.getByRole('button', { name: 'Home', exact: true }).click()
  await page.getByText('Nothing needs you right now.').waitFor()
  assert.equal(
    await page
      .getByRole('button', { name: /Which colour should I use\?/ })
      .count(),
    0,
  )
  checks.push('Home no longer lists the answered session as needing you.')
}

/** Journey 4: two projects, their own histories and places, then a restart. */
const journeyFour = async (page: Page) => {
  const sidebar = page.getByLabel('Sidebar')
  const panel = page.getByRole('complementary', { name: 'Sessions' })
  await sidebar.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Folder path').fill(beta)
  await dialog.getByLabel('Name').fill('Beta')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('heading', { name: 'Beta', exact: true }).waitFor()
  await sendIn(page, 'Message Vela in this project', 'What is in Beta?')
  await page
    .getByText('Beta answer', { exact: true })
    .waitFor({ timeout: 30_000 })
  checks.push('A second project opens on its own empty conversation.')

  const betaProject = await projectNamed(page, 'Beta')
  await waitForIdle(page, betaProject.sessionId)
  await sendIn(page, 'Message Vela in this project', 'Write the Beta notes')
  const betaCard = cardIn(page, 'Write the Beta notes')
  await betaCard.waitFor({ timeout: 30_000 })
  await betaCard.click()
  await panel
    .getByRole('heading', { name: 'Write the Beta notes', exact: true })
    .waitFor()
  const betaTopic = await waitForSessionState(
    page,
    betaProject.id,
    'Write the Beta notes',
    'done',
  )
  await waitForIdle(page, betaTopic.sessionId)
  checks.push("Asking Beta for bigger work opens Beta's own session.")

  await sidebar.getByRole('button', { name: 'Alpha Local' }).click()
  await page
    .getByText('Alpha answer', { exact: true })
    .waitFor({ timeout: 30_000 })
  assert.equal(await page.getByText('Beta answer', { exact: true }).count(), 0)
  checks.push(
    'Switching back to a project shows its history, not the other one.',
  )

  const alpha = await projectNamed(page, 'Alpha')
  await waitForIdle(page, alpha.sessionId)
  await sendIn(page, 'Message Vela in this project', 'Summarise this folder')
  // The whole answer is one message, so the last paragraph is a substring of it.
  const last = page.getByText('Paragraph 40 of a long answer from Vela.')
  await last.waitFor({ timeout: 30_000 })
  const chat = page.getByLabel('Project chat')
  const place = await chat.evaluate((node) => {
    node.scrollTop = 120
    return node.scrollTop
  })
  assert(place > 0, 'The answer left the chat scrollable')
  await sidebar.getByRole('button', { name: 'Beta Local' }).click()
  await page.getByText('Beta answer', { exact: true }).waitFor()
  await sidebar.getByRole('button', { name: 'Alpha Local' }).click()
  await last.waitFor({ timeout: 30_000 })
  await page.waitForFunction(
    (expected) =>
      Math.abs(
        (document.querySelector<HTMLElement>('[aria-label="Project chat"]')
          ?.scrollTop ?? 0) - expected,
      ) < 8,
    place,
  )
  checks.push('A conversation comes back where it was left.')

  await panel
    .getByRole('button', { name: /Fix the retry backoff/ })
    .waitFor({ timeout: 30_000 })
  checks.push("Alpha's panel lists the session started in it.")

  // A draft belongs to the conversation it was typed in, and leaving a session
  // through Home for another project must not carry it over.
  await panel.getByRole('button', { name: /Fix the retry backoff/ }).click()
  await panel.getByLabel('Message in this session').fill('an unsent reply')
  await page.getByRole('button', { name: 'Home', exact: true }).click()
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: /Write the Beta notes/ })
    .click()
  await page.getByRole('heading', { name: 'Beta', exact: true }).waitFor()
  await panel
    .getByRole('heading', { name: 'Write the Beta notes', exact: true })
    .waitFor()
  assert.equal(
    await panel.getByLabel('Message in this session').inputValue(),
    '',
    "The other session's draft does not follow",
  )
  assert.equal(
    await panel.getByText('Fix the retry backoff', { exact: true }).count(),
    0,
    "Beta's panel never shows Alpha's session",
  )
  checks.push(
    'Leaving a session through Home and opening another project resets the panel to that project.',
  )

  await sidebar.getByRole('button', { name: 'Alpha Local' }).click()
  await panel.getByRole('button', { name: /Fix the retry backoff/ }).click()
  assert.equal(
    await panel.getByLabel('Message in this session').inputValue(),
    'an unsent reply',
    "The session's own draft comes back",
  )
  await panel.getByLabel('Message in this session').fill('')
  checks.push('An unsent reply stays with the session it was typed in.')

  await sidebar.getByRole('button', { name: 'Beta Local' }).click()
  await panel.getByRole('button', { name: /Write the Beta notes/ }).waitFor()
  assert.equal(
    await panel.getByRole('button', { name: /Fix the retry backoff/ }).count(),
    0,
  )
  checks.push("Beta's panel has no session from Alpha.")

  await sidebar.getByRole('button', { name: 'Alpha Local' }).click()
  await page.getByText('Alpha answer', { exact: true }).waitFor()
  await noOverflow(page)
  await themes(page, 'journey-4')
}

/** Local wall clock, which is the timezone the host resolves a one-off `at` in. */
const localTime = (offsetMs: number) => {
  const at = new Date(Date.now() + offsetMs)
  const pad = (value: number) => String(value).padStart(2, '0')
  return {
    date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
  }
}

/** The host's own view of one chat's routines, which every row must match. */
const routinesIn = (page: Page, chatId: string) =>
  page.evaluate((id) => window.vela.listRoutines('local', id), chatId)

/** Journey 5: a routine created, edited and cancelled on its own page. */
const journeyFive = async (page: Page) => {
  const sidebar = page.getByLabel('Sidebar')
  const main = page.locator('main')
  const alpha = await projectNamed(page, 'Alpha')

  await sidebar.getByRole('button', { name: 'Routines' }).click()
  await page.getByRole('heading', { name: 'Routines', exact: true }).waitFor()
  const alphaGroup = main.getByRole('region', { name: 'Alpha' })
  await alphaGroup.getByText('No routines yet.').waitFor()
  checks.push('Routines opens from the sidebar, grouped by project.')

  // A project nobody wrote to has no routine target. Say so in the group; asking the
  // host would answer with its own `Unknown or disabled channel target`.
  await sidebar.getByRole('button', { name: 'New project' }).click()
  const newProject = page.getByRole('dialog')
  await newProject.getByLabel('Folder path').fill(gamma)
  await newProject.getByLabel('Name').fill('Gamma')
  await newProject.getByRole('button', { name: 'Create project' }).click()
  await newProject.waitFor({ state: 'hidden' })
  await sidebar.getByRole('button', { name: 'Routines' }).click()
  const gammaGroup = main.getByRole('region', { name: 'Gamma' })
  await gammaGroup
    .getByText(/Routines can point here after the first message/)
    .waitFor()
  assert.equal(
    await gammaGroup.getByRole('alert').count(),
    0,
    'A project with no message shows no host error',
  )
  checks.push(
    'A project with no message says where routines can point, without a host error.',
  )

  const twoDays = localTime(2 * 86_400_000)
  const dialog = page.getByRole('dialog')
  const fillNewRoutine = async () => {
    await page.getByRole('button', { name: 'New routine' }).click()
    await dialog.getByRole('heading', { name: 'New routine' }).waitFor()
    await dialog.getByLabel('What Vela should do').fill('Review the report')
    await dialog.getByLabel('Date').fill(twoDays.date)
    await dialog.getByLabel('Time').fill('09:00')
  }
  await fillNewRoutine()
  const where = dialog.getByRole('combobox', { name: 'Where', exact: true })
  await where.press('ArrowDown')
  const listbox = page.getByRole('listbox')
  await listbox.waitFor()
  const places = await listbox.getByRole('option').allTextContents()
  for (const label of [
    'Alpha · the project chat',
    'Alpha · topic “Fix the retry backoff”',
    'Beta · the project chat',
    'Beta · topic “Write the Beta notes”',
  ])
    assert(
      places.includes(label),
      `Where offers ${label}, and offers ${places.join(', ')}`,
    )
  assert(
    !places.some((label) => label.startsWith('Gamma')),
    'A project with no message is not a place to answer',
  )
  await where.press('Escape')
  await listbox.waitFor({ state: 'hidden' })
  assert(await dialog.isVisible(), 'Escape closes only the listbox')
  assert(await where.evaluate((node) => node === document.activeElement))
  assert.equal(
    await dialog.getByLabel('What Vela should do').inputValue(),
    'Review the report',
    'The first Escape preserves the draft',
  )
  await where.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await fillNewRoutine()
  await pick(page, where, 'Alpha · the project chat')
  await dialog.getByRole('button', { name: 'Create routine' }).click()
  await dialog.waitFor({ state: 'hidden' })

  const created = (await routinesIn(page, alpha.id)).routines
  assert.equal(created.length, 1)
  const routine = created[0]!
  assert.equal(routine.message, 'Review the report')
  assert.equal(routine.target, 'Group channel')
  assert.notEqual(routine.nextRun, null)
  await alphaGroup.getByText('Review the report', { exact: true }).waitFor()
  await alphaGroup.getByText(routine.scheduleText, { exact: true }).waitFor()
  await alphaGroup
    .getByText(`Next: ${routine.nextRun}`, { exact: true })
    .waitFor()
  await alphaGroup
    .getByText('Group channel · set by You', { exact: true })
    .waitFor()
  checks.push(
    'A new routine lists with what it does, where, who set it and the host’s next run.',
  )

  await alphaGroup
    .getByRole('button', { name: 'Edit routine: Review the report' })
    .click()
  await dialog.getByRole('heading', { name: 'Edit routine' }).waitFor()
  assert.equal(await dialog.getByLabel('Date').inputValue(), twoDays.date)
  assert.equal(await dialog.getByLabel('Time').inputValue(), '09:00')
  await dialog.getByText('Group channel', { exact: true }).waitFor()
  await snapshot(page, 'journey-5-edit')
  await dialog.getByLabel('Time').fill('10:30')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await dialog.waitFor({ state: 'hidden' })

  const edited = (await routinesIn(page, alpha.id)).routines[0]!
  assert.equal(edited.id, routine.id)
  assert.equal(edited.message, 'Review the report')
  assert.notEqual(edited.nextRun, routine.nextRun, 'The new time has a new run')
  await alphaGroup
    .getByText(`Next: ${edited.nextRun}`, { exact: true })
    .waitFor()
  checks.push(
    'Edit changes the time in place, the message and id stay, and the row shows the new next run.',
  )

  // A repeated routine in one topic, three hours out so it cannot fire during the run.
  await page.getByRole('button', { name: 'New routine' }).click()
  await dialog.getByRole('heading', { name: 'New routine' }).waitFor()
  await dialog.getByLabel('What Vela should do').fill('Check the CI log')
  await dialog.getByRole('button', { name: 'Repeat' }).click()
  await dialog.getByLabel('Time').fill(localTime(3 * 3_600_000).time)
  await snapshot(page, 'journey-5-repeat')
  await where.press('Home')
  const target = 'Alpha · topic “Fix the retry backoff”'
  const options = listbox.getByRole('option')
  await listbox.waitFor()
  const index = (await options.allTextContents()).indexOf(target)
  assert(index >= 0)
  for (let step = 0; step < index; step += 1) await where.press('ArrowDown')
  assert.equal(
    await where.getAttribute('aria-activedescendant'),
    await options.nth(index).getAttribute('id'),
  )
  await where.press('Enter')
  await listbox.waitFor({ state: 'hidden' })
  assert(
    await dialog.isVisible(),
    'Choosing with Enter does not create the routine',
  )
  await dialog.getByRole('button', { name: 'Create routine' }).click()
  await dialog.waitFor({ state: 'hidden' })

  const topic = (await routinesIn(page, alpha.id)).routines.find(
    (item) => item.message === 'Check the CI log',
  )!
  assert.equal(topic.target, 'Topic: Fix the retry backoff')
  await alphaGroup.getByText('Check the CI log', { exact: true }).waitFor()
  await alphaGroup
    .getByText('Topic: Fix the retry backoff · set by You', { exact: true })
    .waitFor()
  await alphaGroup
    .getByText(`Next: ${topic.nextRun}`, { exact: true })
    .waitFor()
  checks.push(
    'A routine can answer in a topic, named the way the host names it.',
  )

  const deleteRoutine = alphaGroup.getByRole('button', {
    name: 'Delete routine: Review the report',
  })
  await deleteRoutine.click()
  const cancelDelete = dialog.getByRole('button', {
    name: 'Cancel',
    exact: true,
  })
  await cancelDelete.waitFor()
  assert(await cancelDelete.evaluate((node) => node === document.activeElement))
  await cancelDelete.click()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal((await routinesIn(page, alpha.id)).routines.length, 2)
  await deleteRoutine.click()
  await dialog
    .getByRole('button', { name: 'Delete routine', exact: true })
    .click()
  await alphaGroup
    .getByText('Review the report', { exact: true })
    .waitFor({ state: 'detached' })
  await alphaGroup.getByText('Check the CI log', { exact: true }).waitFor()
  assert.equal((await routinesIn(page, alpha.id)).routines.length, 1)
  checks.push(
    'Cancel preserves the routine; confirming deletion removes it and leaves the other one.',
  )

  // A real rejection: yesterday's 09:00 is in the past, so the host refuses it.
  const yesterday = localTime(-86_400_000)
  await page.getByRole('button', { name: 'New routine' }).click()
  await dialog.getByRole('heading', { name: 'New routine' }).waitFor()
  await dialog.getByLabel('What Vela should do').fill('Write the weekly note')
  await dialog.getByLabel('Date').fill(yesterday.date)
  await dialog.getByLabel('Time').fill('09:00')
  await dialog.getByRole('button', { name: 'Create routine' }).click()
  await dialog
    .getByRole('alert')
    .getByText('A one-off routine must be in the future', { exact: true })
    .waitFor()
  assert.equal((await routinesIn(page, alpha.id)).routines.length, 1)
  await snapshot(page, 'journey-5-rejected')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await dialog.waitFor({ state: 'hidden' })
  checks.push(
    'A schedule the host rejects shows the host’s message and adds nothing.',
  )

  await noOverflow(page)
  await themes(page, 'journey-5')
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
/** The scratch environment, with the keys a journey overrides (`undefined` removes one). */
function journeyEnv(overrides: Record<string, string | undefined>) {
  const merged: Record<string, string | undefined> = { ...env, ...overrides }
  for (const key of Object.keys(overrides))
    if (overrides[key] === undefined) delete merged[key]
  return merged as Record<string, string>
}

/** One development Electron, from Forge start to a closed process. */
async function launchDev(overrides: Record<string, string | undefined> = {}) {
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
      env: journeyEnv(overrides),
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
  let browser: import('playwright').Browser | undefined
  try {
    const url = await endpoint
    console.log('Desktop verification: DevTools endpoint ready')
    browser = await chromium.connectOverCDP(url)
    console.log('Desktop verification: connected to Electron')
  } catch (error) {
    // Nothing to close yet: stop the detached Forge ourselves.
    if (child.pid && child.exitCode === null)
      process.kill(-child.pid, 'SIGTERM')
    throw error
  }
  const context = browser.contexts()[0]!
  const page =
    context.pages()[0] ??
    (await context.waitForEvent('page', { timeout: 30_000 }))
  watch(page)
  await page.bringToFront()
  await page.waitForLoadState('networkidle')
  console.log('Desktop verification: first window loaded')
  return {
    page,
    close: async () => {
      try {
        console.log('Desktop verification: closing Electron')
        await closeElectron(browser)
        console.log('Desktop verification: Electron closed')
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
    },
  }
}

async function development() {
  // The stale-model mode has no model handed to the host, or there would be nothing to check.
  const first = await launchDev(staleModel ? { VELA_MODEL: undefined } : {})

  try {
    const { page } = first
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
    if (brokenAuth) {
      const alert = page.getByRole('alert')
      await alert.waitFor({ timeout: 30_000 })
      const reason = (await alert.textContent()) ?? ''
      assert(
        reason.includes('auth.json'),
        `The window names the unreadable file: ${reason}`,
      )
      checks.push(
        'An auth.json Vela cannot read shows its reason in the window instead of a blank frame.',
      )
      await snapshot(page, 'broken-auth')
      return
    }
    if (staleModel) {
      // Setup replaces the frame, so the wordmark is not the page heading here.
      await page.getByRole('heading', { name: 'Give Vela a model.' }).waitFor()
      await rendererSafety(page)
      await page
        .getByText(/removed-provider\/some-model/, { exact: false })
        .waitFor()
      checks.push(
        'A saved model whose provider is gone opens setup and names that model.',
      )
      await noOverflow(page)
      await snapshot(page, 'stale-model')
      return
    }
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
    await page.setViewportSize({ width: 1280, height: 800 })
    console.log('Desktop verification: starting journey 1')
    await journeyOne(page)
    console.log('Desktop verification: journey 1 passed')
    console.log('Desktop verification: starting journey 2')
    await journeyTwo(page)
    console.log('Desktop verification: journey 2 passed')
    console.log('Desktop verification: starting journey 3')
    await journeyThree(page)
    console.log('Desktop verification: journey 3 passed')
    console.log('Desktop verification: starting journey 4')
    await journeyFour(page)
    console.log('Desktop verification: journey 4 passed')
    console.log('Desktop verification: starting journey 5')
    await journeyFive(page)
    console.log('Desktop verification: journey 5 passed')
  } finally {
    await first.close()
  }
  await restartJourney()
  await firstRunJourney()
  await larkJourneys()
  await larkOffJourney()
  await groupDiscoveryJourney()
}

/**
 * Journey 6: an empty data directory opens on setup. A wrong key is refused before anything is
 * written; a good one saves the model, and the CLI then reads the same configuration.
 */
async function firstRunJourney() {
  console.log('Desktop verification: starting journey 6')
  const provider = startVerifyProvider()
  const dir = await mkdtemp(resolve(dataParent, 'vela-first-run-'))
  firstRunData = dir
  // A developer or CI with a provider key exported would close the gate this journey needs open.
  const third = await launchDev({
    VELA_DIR: dir,
    VELA_MODEL: undefined,
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    OPENAI_API_BASE_URL: undefined,
    OPENAI_API_MODEL_NAME: undefined,
    OPENROUTER_API_KEY: undefined,
    DEEPSEEK_API_KEY: undefined,
  })
  try {
    const { page } = third
    await page.setViewportSize({ width: 1280, height: 800 })
    // The development window opens the specimen first; the product entry is index.html.
    await page.goto(new URL('index.html', page.url()).href)
    const title = page.getByRole('heading', { name: 'Give Vela a model.' })
    await title.waitFor()
    assert.equal(
      await page.getByLabel('Sidebar').count(),
      0,
      'Setup replaces the frame',
    )
    checks.push(
      'An empty data directory opens on setup, with no sidebar to leave it.',
    )

    const providers = page.getByRole('combobox', {
      name: 'Provider',
      exact: true,
    })
    assert.match(await providers.innerText(), /^anthropic/)
    await providers.press('ArrowDown')
    const providerList = page.getByRole('listbox')
    await providerList.waitFor()
    assert.deepEqual(
      (await providerList.getByRole('option').allTextContents())
        .map((name) => name.replace(' (no key)', ''))
        .sort(),
      ['Custom provider', 'anthropic', 'deepseek', 'openai', 'openrouter'],
    )
    await providers.press('Escape')
    await providerList.waitFor({ state: 'hidden' })
    const submit = page.getByRole('button', { name: 'Verify and save' })
    const initialModel = page.getByRole('combobox', {
      name: 'Model',
      exact: true,
    })
    const initialModelName = await initialModel.innerText()
    await initialModel.press('ArrowDown')
    assert.equal(
      initialModelName,
      await providerList.getByRole('option').first().innerText(),
    )
    await initialModel.press('Escape')
    await providerList.waitFor({ state: 'hidden' })
    assert.equal(await submit.isDisabled(), true, 'No key yet')
    await snapshot(page, 'journey-6-first-run')
    await page.getByLabel(/^API key/).fill(GOOD_KEY)
    assert.equal(
      await submit.isDisabled(),
      false,
      'A prefilled model and a key are enough to submit',
    )
    checks.push(
      'A fresh install opens on a built-in provider with its model chosen, and a key is the only thing missing.',
    )

    await pick(page, providers, 'Custom provider')
    await page.getByLabel('Provider name').fill('faux')
    await pick(
      page,
      page.getByRole('combobox', { name: 'Protocol', exact: true }),
      'OpenAI Chat Completions',
    )
    await page.getByLabel('Base URL').fill(provider.baseUrl)
    await page.getByLabel('Model ID').fill(reasoningModel)
    await page.getByLabel('API key').fill('wrong-key')
    assert.equal(
      await page.evaluate(() => scrollY),
      0,
      'Setup has not scrolled',
    )
    const inViewport = (element: typeof submit) =>
      element.evaluate((node) => {
        const { top, bottom, left, right, width, height } =
          node.getBoundingClientRect()
        return (
          width > 0 &&
          height > 0 &&
          top >= 0 &&
          left >= 0 &&
          bottom <= innerHeight &&
          right <= innerWidth
        )
      })
    assert(await inViewport(submit), 'Custom setup action fits at 1280×800')
    await submit.click()
    const alert = page.getByRole('alert')
    await alert.waitFor({ timeout: 60_000 })
    const reason = (await alert.textContent()) ?? ''
    assert.equal(
      reason,
      'invalid api key',
      `The alert carries the provider's reason alone, got: ${reason}`,
    )
    assert(await inViewport(alert), 'The refusal is visible at 1280×800')
    assert(
      await inViewport(submit),
      'The retry action stays visible at 1280×800',
    )
    for (const name of ['settings.json', 'models.json', 'auth.json'])
      assert.equal(
        await Bun.file(resolve(dir, name)).exists(),
        false,
        `A rejected key writes no ${name}`,
      )
    checks.push(
      'A wrong key is refused with the provider’s reason and writes none of the three files.',
    )
    await themes(page, 'journey-6-setup-error')

    await page.getByLabel('API key').fill(GOOD_KEY)
    await page.getByRole('button', { name: 'Verify and save' }).click()
    await page.getByRole('heading', { name: 'Home', exact: true }).waitFor({
      timeout: 60_000,
    })
    await title.waitFor({ state: 'hidden' })
    const state = await page.evaluate(() => window.vela.settings())
    assert.equal(state.setup.required, false)
    assert.equal(state.model, `faux/${reasoningModel}`)
    assert.equal(state.files.settings, resolve(dir, 'settings.json'))
    assert(
      !JSON.stringify(state).includes(GOOD_KEY),
      'The settings the page reads carry no key',
    )
    checks.push(
      'A good key saves the model and opens Home, with the state the bridge reports and no key in it.',
    )

    const settings = JSON.parse(
      await readFile(resolve(dir, 'settings.json'), 'utf8'),
    )
    assert.equal(settings.defaultModel, `faux/${reasoningModel}`)
    const auth = JSON.parse(await readFile(resolve(dir, 'auth.json'), 'utf8'))
    assert.deepEqual(auth.faux, { type: 'api_key', key: GOOD_KEY })
    const models = JSON.parse(
      await readFile(resolve(dir, 'models.json'), 'utf8'),
    )
    assert.equal(models.providers.faux.api, 'openai-completions')
    assert.equal(models.providers.faux.baseUrl, provider.baseUrl)
    assert.deepEqual(models.providers.faux.models, [{ id: reasoningModel }])
    for (const name of ['settings.json', 'auth.json'])
      assert.equal(
        (await stat(resolve(dir, name))).mode & 0o777,
        0o600,
        `${name} is private`,
      )
    checks.push(
      'The window writes settings.json, auth.json (0600) and the custom provider to models.json.',
    )

    await page.reload()
    await page.getByRole('heading', { name: 'Home', exact: true }).waitFor()
    assert.equal(await title.count(), 0)
    checks.push('A reload opens Home, because the saved configuration is read.')
    await themes(page, 'journey-6-home')

    const settingsTitle = page.getByRole('heading', {
      level: 1,
      name: 'Settings',
    })
    await page
      .getByLabel('Sidebar')
      .getByRole('button', { name: 'Settings' })
      .click()
    await settingsTitle.waitFor()
    const sections = page.getByLabel('Settings sections')
    await sections.getByRole('button', { name: 'General' }).waitFor()
    await page
      .getByText(resolve(dir, 'settings.json'), { exact: true })
      .waitFor()
    await page.getByText(dir, { exact: true }).waitFor()
    checks.push(
      'Settings opens from the sidebar foot on General, naming the Vela folder and settings.json.',
    )

    await sections.getByRole('button', { name: 'Models' }).click()
    await page.getByRole('heading', { name: 'Models', exact: true }).waitFor()
    await page.getByText(`faux/${reasoningModel}`, { exact: true }).waitFor()
    assert.equal(
      await page.getByText('settings.json', { exact: true }).count(),
      1,
      'The model names settings.json',
    )
    // No thinking level is recorded on a fresh install, so no row claims one.
    assert.equal(
      await page.getByText('Thinking level', { exact: true }).count(),
      0,
      'A level Vela never saved is not shown',
    )
    await page.getByText('Saved', { exact: true }).waitFor()
    await page.getByText('auth.json', { exact: true }).waitFor()
    await page.getByText('models.json', { exact: true }).waitFor()
    checks.push(
      'Settings › Models shows the saved model and key source, without a thinking level nothing recorded, and the file each row writes.',
    )
    await themes(page, 'journey-6-settings')

    await page.getByRole('button', { name: 'Change model' }).click()
    const dialog = page.getByRole('dialog')
    await dialog
      .getByRole('combobox', { name: 'Provider', exact: true })
      .waitFor()
    assert.equal(
      await dialog
        .getByRole('combobox', { name: 'Provider', exact: true })
        .innerText(),
      'faux',
    )
    assert.equal(
      await dialog
        .getByRole('combobox', { name: 'Model', exact: true })
        .innerText(),
      reasoningModel,
    )
    assert.equal(
      await dialog.getByLabel('API key').inputValue(),
      '',
      'A saved key never comes back to the page',
    )
    await snapshot(page, 'journey-6-model-dialog')
    checks.push(
      'Change model opens the same form on the saved provider and model, with an empty key field.',
    )
    await Bun.write(
      resolve(dir, 'models.json'),
      JSON.stringify({
        providers: {
          faux: {
            ...models.providers.faux,
            models: [{ id: reasoningModel, reasoning: true }],
          },
        },
      }),
    )
    await pick(
      page,
      dialog.getByRole('combobox', { name: 'Thinking level', exact: true }),
      'High',
    )
    await dialog.getByRole('button', { name: 'Verify and save' }).click()
    await dialog.waitFor({ state: 'hidden' })
    const savedLevel = async () =>
      (await Bun.file(resolve(dir, 'settings.json')).json())
        .defaultThinkingLevel
    assert.equal(await savedLevel(), 'high')
    await page.getByText('high', { exact: true }).waitFor()

    // The host must be using the model it saved: an endpoint that only answers `good-key` and
    // streams a reply, driven through the app's own composer.
    await page
      .getByLabel('Sidebar')
      .getByRole('button', { name: 'Home' })
      .click()
    await page.getByRole('heading', { name: 'Home', exact: true }).waitFor()
    await page.getByRole('button', { name: 'New project' }).click()
    const projectDialog = page.getByRole('dialog')
    await projectDialog.getByLabel('Folder path').fill(project)
    await projectDialog.getByLabel('Name').fill('Setup project')
    await projectDialog.getByRole('button', { name: 'Create project' }).click()
    await projectDialog.waitFor({ state: 'hidden' })
    await page.getByRole('heading', { name: 'Setup project' }).waitFor()
    const composer = page.getByLabel('Message Vela in this project')
    await composer.fill('Does the saved model answer?')
    await page.getByRole('button', { name: 'Send' }).click()
    await page
      .getByText('Local answer', { exact: true })
      .waitFor({ timeout: 60_000 })
    assert.equal(
      provider.lastStreamEffort(),
      'high',
      'A new session uses the saved effort without restart',
    )
    const firstStreamCount = provider.streamCount()
    await page
      .getByLabel('Sidebar')
      .getByRole('button', { name: 'Settings' })
      .click()
    await sections.getByRole('button', { name: 'Models' }).click()
    await page.getByRole('button', { name: 'Change model' }).click()
    assert.equal(
      await dialog
        .getByRole('combobox', { name: 'Thinking level', exact: true })
        .innerText(),
      'Keep current',
    )
    await dialog.getByRole('button', { name: 'Verify and save' }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await savedLevel(), 'high')
    // Home sends Local messages to the project's same session, so use a new project
    // here to observe setDefaults on a genuinely different, newly created SDK session.
    const secondProject = resolve(dir, 'second-project')
    await mkdir(secondProject)
    await page
      .getByLabel('Sidebar')
      .getByRole('button', { name: 'New project' })
      .click()
    await projectDialog.getByLabel('Folder path').fill(secondProject)
    await projectDialog.getByLabel('Name').fill('Second setup project')
    await projectDialog.getByRole('button', { name: 'Create project' }).click()
    await projectDialog.waitFor({ state: 'hidden' })
    await page
      .getByRole('heading', { name: 'Second setup project', exact: true })
      .waitFor()
    await sendIn(
      page,
      'Message Vela in this project',
      'Does the next session still think high?',
    )
    await page
      .getByText('Local answer', { exact: true })
      .waitFor({ timeout: 60_000 })
    assert.equal(
      provider.lastStreamEffort(),
      'high',
      'Keep current preserves the effort on another fresh session',
    )
    assert.equal(
      provider.streamCount(),
      firstStreamCount + 1,
      'The second probe reaches the provider',
    )
    await page.reload()
    await page
      .getByLabel('Sidebar')
      .getByRole('button', { name: 'Settings' })
      .click()
    await sections.getByRole('button', { name: 'Models' }).click()
    await page.getByText('high', { exact: true }).waitFor()
    checks.push(
      'Thinking High reaches the local provider on a fresh session in the running host, survives Keep current on a second session, and remains visible after reload.',
    )

    const cli = Bun.spawnSync(
      [
        'bun',
        resolve(root, '../../packages/vela/src/cli/main.ts'),
        '--list-models',
      ],
      {
        cwd: project,
        env: {
          ...(process.env as Record<string, string>),
          HOME: home,
          VELA_DIR: dir,
          VELA_MODEL: '',
          LARK_APP_ID: '',
          LARK_APP_SECRET: '',
          LARK_OWNERS: '',
        },
      },
    )
    const list = cli.stdout.toString()
    assert.equal(
      cli.exitCode,
      0,
      `vela --list-models failed: ${cli.stderr.toString()}`,
    )
    assert(list.includes(reasoningModel), `--list-models printed: ${list}`)
    checks.push(
      'The CLI reads the same directory: vela --list-models prints the saved model.',
    )
    console.log('Desktop verification: journey 6 passed')
  } catch (cause) {
    provider.stop()
    throw cause
  } finally {
    await third.close()
  }
  try {
    const testSecret = crypto.randomUUID()
    await seedLarkChat(dir, testSecret)
    const fourth = await launchDev({
      VELA_DIR: dir,
      VELA_MODEL: undefined,
      VELA_DESKTOP_LARK: 'fake',
      VELA_DESKTOP_LARK_DIR: undefined,
    })
    try {
      checks.push(
        ...(await verifyLarkSettings(
          fourth.page,
          dir,
          project,
          themes,
          provider.hold,
          testSecret,
        )),
      )
    } finally {
      await fourth.close()
    }
    const output = await readFile(resolve(evidence, 'forge.log'), 'utf8')
    assert(
      !output.includes(testSecret),
      'Desktop process output excludes the saved secret',
    )
  } finally {
    provider.stop()
  }
}

/** One person's line in the fake Lark group, delivered by the transport's poller. */
const larkSays = async (control: { op: string; [key: string]: unknown }) => {
  const path = resolve(larkDir, 'control.jsonl')
  await appendFile(path, `${JSON.stringify(control)}\n`)
  const lines = (await readFile(path, 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '').length
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const handled = JSON.parse(
        await readFile(resolve(larkDir, 'handled.json'), 'utf8'),
      ) as { lines?: number }
      if ((handled.lines ?? 0) >= lines) return
    } catch {
      // The first line is still on its way.
    }
    await Bun.sleep(20)
  }
  throw new Error('The fake Lark did not pick up the control line')
}

/**
 * The Lark journeys, on a scratch data directory whose only enabled group is the fake
 * `oc_alpha`: group chat, a topic started from Home, an uncertain send, a waiting
 * topic, and switching between a Lark project and a Local one without a reload.
 */
async function larkJourneys() {
  const dir = await mkdtemp(resolve(dataParent, 'vela-lark-'))
  larkData = dir
  await Bun.write(
    resolve(dir, 'settings.json'),
    JSON.stringify({
      shellPath: shell,
      extensionConfig: {
        lark: {
          chats: [
            larkProject,
            gapProject,
            liveProject,
            jumpProject,
            emptyProject,
            denyProject,
            raceProject,
          ],
        },
      },
    }),
  )
  await Bun.write(
    resolve(larkDir, 'seed.json'),
    JSON.stringify({
      chats: {
        [gapProject]: {
          name: 'Vela gap',
          messages: Array.from({ length: 60 }, (_, index) => ({
            sender: 'Alice',
            text: `Gap message ${index + 1} of the second group.`,
          })),
        },
        [liveProject]: {
          name: 'Vela live',
          messages: Array.from({ length: 120 }, (_, index) => ({
            sender: index % 2 === 0 ? 'Alice' : 'Bob',
            text: `Live message ${index + 1} of the third group.`,
          })),
        },
        [jumpProject]: {
          name: 'Vela jump',
          messages: Array.from({ length: 100 }, (_, index) => ({
            sender: 'Bob',
            text: `Jump message ${index + 1} of the fourth group.`,
          })),
        },
        [emptyProject]: { name: 'Vela empty' },
        [denyProject]: {
          name: 'Vela deny',
          messages: Array.from({ length: 3 }, (_, index) => ({
            sender: 'Bob',
            text: `Deny message ${index + 1} of the sixth group.`,
          })),
        },
        [raceProject]: {
          name: 'Vela race',
          messages: Array.from({ length: 160 }, (_, index) => ({
            sender: 'Bob',
            text: `Race message ${index + 1} of the seventh group.`,
          })),
        },
        [larkProject]: {
          name: 'Vela dev',
          messages: [
            // More than one page, so "Show earlier messages" has something to load.
            ...Array.from({ length: 55 }, (_, index) => ({
              sender: index % 2 === 0 ? 'Alice' : 'Bob',
              text: `Old message ${index + 1} of the group backlog.`,
            })),
            { sender: 'Alice', text: 'Morning, everyone.' },
            { sender: 'Bob', text: 'The nightly build is green.' },
            {
              sender: 'Vela',
              app: true,
              text: 'I will keep an eye on the retry test.',
            },
          ],
        },
      },
    }),
  )
  await Bun.write(resolve(larkDir, 'control.jsonl'), '')
  await Bun.write(
    larkScenario,
    JSON.stringify({
      responses: [
        // The app's short question in the group.
        { text: 'The retry test now covers a 429.' },
        // A person asking in the group.
        { text: 'Only the deploy step changed.' },
        // The busy group's live message.
        { text: 'Noted, the oldest page is still the end.' },
        { text: 'Noted, the busy group is answered.' },
        // Starting a topic from Home: a slow step keeps it visibly running.
        { toolCalls: [{ name: 'bash', input: { command: 'sleep 3' } }] },
        { text: 'I will read the deploy script first.' },
        // A reply in the same topic.
        { text: 'The deploy script still points at staging.' },
        // A topic that asks the person a question.
        {
          toolCalls: [
            {
              name: 'channel_wait_for_input',
              input: { reason: 'Which colour should I use?' },
            },
          ],
        },
        { text: 'Which colour should I use?' },
        { text: 'Blue it is.' },
        { text: 'The unopened group received its answer.' },
        { text: 'The unopened topic received its answer.' },
        // A Local question in the same window.
        { text: 'Local answer in the same window.' },
      ],
      generate: Array.from({ length: 20 }, () => ({
        text: 'Compacted history',
      })),
    }),
  )
  console.log('Desktop verification: starting the Lark journeys')
  const lark = await launchDev({
    VELA_DIR: dir,
    VELA_MODEL: `faux:${larkScenario}`,
    VELA_DESKTOP_LARK: 'fake',
    VELA_DESKTOP_LARK_DIR: larkDir,
    LARK_APP_ID: 'cli_desktop_fake',
    LARK_APP_SECRET: 'fake-secret',
  })
  try {
    const { page } = lark
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(new URL('index.html', page.url()).href)
    await page.getByRole('heading', { name: 'Home', exact: true }).waitFor()
    await page.getByRole('heading', { name: 'VELA', exact: true }).waitFor()
    const sidebar = page.getByLabel('Sidebar')
    const panel = page.getByRole('complementary', { name: 'Sessions' })
    const projectButton = sidebar.getByRole('button', {
      name: 'Vela dev Lark',
    })
    await projectButton.waitFor({ timeout: 30_000 })
    await page.getByText('Lark · on', { exact: true }).waitFor()
    checks.push(
      'A Lark group from the enabled chats is a project with the Lark tag, and the sidebar shows Lark · on.',
    )

    // Group history, a question from the app, and a person's answer in the group.
    await projectButton.click()
    await page.getByRole('heading', { name: 'Vela dev', exact: true }).waitFor()
    const banner = page.getByRole('banner')
    assert.equal(await banner.getByText('Lark', { exact: true }).count(), 1)
    assert(
      (await banner.textContent())?.includes(larkProject),
      'The header names the chat id',
    )
    await page.getByText('Alice', { exact: true }).first().waitFor()
    await page.getByText('Morning, everyone.', { exact: true }).waitFor()
    await page.getByText('Bob', { exact: true }).first().waitFor()
    await page
      .getByText('The nightly build is green.', { exact: true })
      .waitFor()
    await page
      .getByText('I will keep an eye on the retry test.', { exact: true })
      .waitFor()
    checks.push(
      "The group chat shows people's messages with their names and Vela's reply.",
    )
    await page
      .getByText(/Vela posts it in the group as the bot, signed Vela app/)
      .waitFor()
    checks.push(
      'The project composer says the bot posts in the group, signed Vela app.',
    )

    const chat = page.getByLabel('Project chat')
    await sendIn(
      page,
      'Message Vela in this group',
      'What changed in the retry test?',
    )
    await chat
      .getByText('Vela app: What changed in the retry test?', { exact: true })
      .waitFor({ timeout: 30_000 })
    await chat
      .getByText('The retry test now covers a 429.', { exact: true })
      .waitFor({ timeout: 30_000 })
    assert.equal(
      await chat
        .locator('[data-role="user"]')
        .filter({ hasText: 'What changed in the retry test?' })
        .count(),
      0,
      "The app's post is the bot's, not the person's bubble",
    )
    checks.push(
      "A short question sent from the app lands in the group as the bot with Vela app's signature, and the answer shows in the app.",
    )

    await larkSays({
      op: 'say',
      chatId: larkProject,
      text: 'Anything else I should know?',
      senderName: 'Alice',
    })
    await chat
      .getByText('Anything else I should know?', { exact: true })
      .waitFor({ timeout: 30_000 })
    await chat
      .getByText('Only the deploy step changed.', { exact: true })
      .waitFor({ timeout: 30_000 })
    checks.push(
      "A person's message in the group shows with their name, and Vela's answer comes back to the app.",
    )

    assert.equal(
      await page
        .getByText('Old message 1 of the group backlog.', { exact: true })
        .count(),
      0,
      'The first page is the newest 50 messages',
    )
    await page.getByRole('button', { name: 'Show earlier messages' }).click()
    await page
      .getByText('Old message 1 of the group backlog.', { exact: true })
      .waitFor({ timeout: 30_000 })
    checks.push(
      'The group reads its newest page first and loads earlier history when the person asks.',
    )

    // A long disconnect: the page holds 11–60, then 60 messages arrive, and the
    // refresh returns only 71–120. The gap is filled by reading back until the new
    // page reaches what is on screen, so 61–70 never go missing.
    await sidebar.getByRole('button', { name: 'Vela gap Lark' }).click()
    await page.getByRole('heading', { name: 'Vela gap', exact: true }).waitFor()
    await page
      .getByText('Gap message 60 of the second group.', { exact: true })
      .waitFor({ timeout: 30_000 })
    assert.equal(
      await page
        .getByText('Gap message 10 of the second group.', { exact: true })
        .count(),
      0,
      'The first page is the newest 50 messages',
    )
    await larkSays({
      op: 'backlog',
      chatId: gapProject,
      texts: Array.from(
        { length: 60 },
        (_, index) => `Late message ${index + 61} of the second group.`,
      ),
    })
    // The backlog is stamped after the read that cached 11–60, so the cursor this page
    // holds cannot reach it: the refresh has to read back to close the gap.
    await Bun.sleep(2500)
    await sidebar.getByRole('button', { name: 'Home', exact: true }).click()
    await sidebar.getByRole('button', { name: 'Vela gap Lark' }).click()
    await page
      .getByText('Late message 120 of the second group.', { exact: true })
      .waitFor({ timeout: 30_000 })
    await page
      .getByText('Late message 65 of the second group.', { exact: true })
      .waitFor({ timeout: 30_000 })
    assert.equal(
      await page
        .getByText('Gap message 10 of the second group.', { exact: true })
        .count(),
      0,
      'The page still starts where the person had paged to',
    )
    await page
      .getByText('Gap message 60 of the second group.', { exact: true })
      .waitFor()
    checks.push(
      'After a long disconnect the refresh reads back to the page on screen, so the messages in between are not skipped.',
    )
    // One page further reaches the start of the group, and the button goes away.
    await page.getByRole('button', { name: 'Show earlier messages' }).click()
    await page
      .getByText('Gap message 1 of the second group.', { exact: true })
      .waitFor({ timeout: 30_000 })
    assert.equal(
      await page.getByRole('button', { name: 'Show earlier messages' }).count(),
      0,
      'The oldest page is the end of the history',
    )
    await larkSays({
      op: 'say',
      chatId: gapProject,
      text: 'A new message after reaching the oldest page',
    })
    await page
      .getByText('Noted, the oldest page is still the end.', { exact: true })
      .waitFor({ timeout: 30_000 })
    assert.equal(
      await page.getByRole('button', { name: 'Show earlier messages' }).count(),
      0,
      'A live refresh does not restore paging after reaching the oldest message',
    )
    checks.push(
      'Paging reaches the oldest message after reconnect and stays exhausted after a live refresh.',
    )

    // Ordinary activity must not reset paging: a live message overlaps the page on
    // screen, so Show earlier still reaches the oldest history.
    await sidebar.getByRole('button', { name: 'Vela live Lark' }).click()
    await page
      .getByRole('heading', { name: 'Vela live', exact: true })
      .waitFor()
    await page
      .getByText('Live message 120 of the third group.', { exact: true })
      .waitFor({ timeout: 30_000 })
    assert.equal(
      await page
        .getByText('Live message 70 of the third group.', { exact: true })
        .count(),
      0,
      'The first page is the newest 50 messages',
    )
    await page.getByRole('button', { name: 'Show earlier messages' }).click()
    await page
      .getByText('Live message 21 of the third group.', { exact: true })
      .waitFor({ timeout: 30_000 })
    await larkSays({
      op: 'say',
      chatId: liveProject,
      text: 'A live message in the busy group',
    })
    await page
      .getByText('A live message in the busy group', { exact: true })
      .waitFor({ timeout: 30_000 })
    await page
      .getByText('Noted, the busy group is answered.', { exact: true })
      .waitFor({ timeout: 30_000 })
    assert.equal(
      await page
        .getByText('Live message 21 of the third group.', { exact: true })
        .count(),
      1,
      'The refresh kept what the person had already paged to',
    )
    await page.getByRole('button', { name: 'Show earlier messages' }).click()
    await page
      .getByText('Live message 1 of the third group.', { exact: true })
      .waitFor({ timeout: 30_000 })
    checks.push(
      'An ordinary live message does not reset paging: Show earlier still reaches the oldest history.',
    )

    // A newest page the host filtered to nothing carries no range, so it cannot mean
    // the older history was recalled: the page keeps what it shows.
    await larkSays({ op: 'filterNewest', chatId: liveProject, count: 51 })
    await sidebar.getByRole('button', { name: 'Home', exact: true }).click()
    await sidebar.getByRole('button', { name: 'Vela live Lark' }).click()
    await page
      .getByRole('heading', { name: 'Vela live', exact: true })
      .waitFor()
    await page
      .getByText('Live message 1 of the third group.', { exact: true })
      .waitFor({ timeout: 30_000 })
    await page
      .getByText('Live message 21 of the third group.', { exact: true })
      .waitFor()
    checks.push(
      'A newest page with no visible rows never erases the history the page already read.',
    )

    // A filtered page inside the gap a long absence leaves: the refresh must read past
    // it, or the messages after it never appear and Show earlier jumps over them.
    await sidebar.getByRole('button', { name: 'Vela jump Lark' }).click()
    await page
      .getByRole('heading', { name: 'Vela jump', exact: true })
      .waitFor()
    await page
      .getByText('Jump message 100 of the fourth group.', { exact: true })
      .waitFor({ timeout: 30_000 })
    await larkSays({
      op: 'backlog',
      chatId: jumpProject,
      texts: Array.from(
        { length: 120 },
        (_, index) => `New message ${index + 101} of the fourth group.`,
      ),
    })
    await larkSays({
      op: 'filterText',
      chatId: jumpProject,
      texts: Array.from(
        { length: 50 },
        (_, index) => `New message ${index + 121} of the fourth group.`,
      ),
    })
    await Bun.sleep(2500)
    await sidebar.getByRole('button', { name: 'Home', exact: true }).click()
    await sidebar.getByRole('button', { name: 'Vela jump Lark' }).click()
    await page
      .getByRole('heading', { name: 'Vela jump', exact: true })
      .waitFor()
    await page
      .getByText('New message 220 of the fourth group.', { exact: true })
      .waitFor({ timeout: 30_000 })
    await page
      .getByText('New message 120 of the fourth group.', { exact: true })
      .waitFor({ timeout: 30_000 })
    assert.equal(
      await page
        .getByText('Jump message 15 of the fourth group.', { exact: true })
        .count(),
      0,
      'The refresh stops where the person had paged to',
    )
    await page.getByRole('button', { name: 'Show earlier messages' }).click()
    await page
      .getByText('Jump message 21 of the fourth group.', { exact: true })
      .waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Show earlier messages' }).click()
    await page
      .getByText('Jump message 1 of the fourth group.', { exact: true })
      .waitFor({ timeout: 30_000 })
    assert.equal(
      await page.getByRole('button', { name: 'Show earlier messages' }).count(),
      0,
      'The oldest page is the end of the history',
    )
    checks.push(
      'A filtered page inside a disconnect gap is read past, so the messages after it appear and paging still reaches the oldest.',
    )
    await sidebar.getByRole('button', { name: 'Vela dev Lark' }).click()
    await page
      .getByText('Old message 55 of the group backlog.', { exact: true })
      .waitFor()
    await noOverflow(page)
    await themes(page, 'lark-journey-chat')

    // A session started from Home opens a topic, runs and finishes, then continues.
    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await page.getByRole('heading', { name: 'Home', exact: true }).waitFor()
    assert.equal(
      await page
        .getByRole('combobox', { name: 'Project', exact: true })
        .textContent(),
      'Vela live · Lark',
      'Home defaults to the last project used',
    )
    const projectPicker = page.getByRole('combobox', {
      name: 'Project',
      exact: true,
    })
    await projectPicker.press('ArrowDown')
    const projects = page.getByRole('listbox')
    await projects.waitFor()
    const projectMenu = (await projects.boundingBox())!
    const projectTrigger = (await projectPicker.boundingBox())!
    assert(
      projectMenu.y >= 0 &&
        projectMenu.y + projectMenu.height <= projectTrigger.y + 1,
      'The Home dock list opens upward and stays on screen',
    )
    await projects
      .getByRole('option', { name: 'Vela dev · Lark', exact: true })
      .click()
    assert.equal(await page.locator('select').count(), 0)
    assert(
      await projectPicker.evaluate(
        (element) => document.activeElement === element,
      ),
      'Changing the Home project leaves focus on the picker',
    )
    await page
      .getByText('Vela opens a topic in Vela dev for it, started by you.')
      .waitFor()
    checks.push(
      'Home starts a session in the Lark project by opening a topic in the group.',
    )
    await sendIn(page, 'Message Vela', 'Check the deploy script')
    await page.getByRole('heading', { name: 'Vela dev', exact: true }).waitFor()
    const card = cardIn(page, 'Check the deploy script')
    await card.waitFor({ timeout: 30_000 })
    const topic = await waitForSessionState(
      page,
      larkProject,
      'Check the deploy script',
      'running',
      30_000,
      'lark',
    )
    await card.click()
    await panel
      .getByRole('heading', { name: 'Check the deploy script', exact: true })
      .waitFor()
    await panel.getByText('Running', { exact: true }).waitFor()
    await waitForSessionState(
      page,
      larkProject,
      'Check the deploy script',
      'done',
      30_000,
      'lark',
    )
    await panel.getByText('Done', { exact: true }).waitFor()
    await panel
      .getByText('I will read the deploy script first.', { exact: true })
      .waitFor({ timeout: 30_000 })
    checks.push(
      'Starting a session from Home opens a topic: the panel shows it running and then done, with its reply.',
    )

    await waitForIdle(page, topic.sessionId, 30_000, 'lark')
    await sendIn(page, 'Message Vela in this topic', 'What does it deploy?')
    await panel
      .getByText('The deploy script still points at staging.', { exact: true })
      .waitFor({ timeout: 30_000 })
    const settled = await waitForSessionState(
      page,
      larkProject,
      'Check the deploy script',
      'done',
      30_000,
      'lark',
    )
    assert.equal(settled.sessionId, topic.sessionId, 'The same topic continued')
    const topics = await page.evaluate(
      (chatId) => window.vela.sessions('lark', chatId),
      larkProject,
    )
    assert.equal(
      topics.filter((session) => session.topic).length,
      1,
      'The reply did not open another topic',
    )
    checks.push(
      'A reply sent in the app continues the same topic and opens no second one.',
    )
    await panel
      .getByRole('button', { name: 'Open the group in Lark' })
      .waitFor()
    await themes(page, 'lark-journey-topic')

    // A topic whose next history read fails says why, and the read after that shows
    // the conversation: the panel never sits on an unexplained empty conversation.
    const threadIdent = (
      await page.evaluate(
        (chatId) => window.vela.sessions('lark', chatId),
        larkProject,
      )
    ).find((session) => session.sessionId === topic.sessionId)!.topic!
    await panel.getByRole('button', { name: 'All sessions' }).click()
    // Development StrictMode can mount the detail twice. Both mounts must see the
    // same service failure until the test explicitly restores the transport.
    await larkSays({
      op: 'setTopicHistoryFailure',
      threadId: threadIdent.threadId,
      active: true,
    })
    await panel.getByRole('button', { name: /Check the deploy script/ }).click()
    const topicHistoryError = page.getByRole('alert').filter({
      hasText: 'Fake Lark denied the topic history',
    })
    await panel
      .getByRole('alert')
      .and(topicHistoryError)
      .waitFor({ timeout: 30_000 })
    assert.equal(
      await topicHistoryError.count(),
      1,
      'A topic history error is not shown on the group composer',
    )
    await panel.getByRole('button', { name: 'All sessions' }).click()
    await topicHistoryError.waitFor({ state: 'hidden' })
    await larkSays({
      op: 'setTopicHistoryFailure',
      threadId: threadIdent.threadId,
      active: false,
    })
    await panel.getByRole('button', { name: /Check the deploy script/ }).click()
    await panel
      .getByText('I will read the deploy script first.', { exact: true })
      .waitFor({ timeout: 30_000 })
    checks.push(
      'A topic whose history read fails shows the reason, and the next read shows the conversation.',
    )

    // A card in the middle of a topic: the host filters it out of its page, and the
    // read must continue to the text behind it.
    await larkSays({
      op: 'cardInTopic',
      chatId: larkProject,
      threadId: threadIdent.threadId,
      after: 'Check the deploy script',
    })
    await panel.getByRole('button', { name: 'All sessions' }).click()
    await panel.getByRole('button', { name: /Check the deploy script/ }).click()
    await panel
      .getByText('The deploy script still points at staging.', { exact: true })
      .waitFor({ timeout: 30_000 })
    assert.equal(
      await panel.getByText('progress', { exact: true }).count(),
      0,
      'A card is not shown as text',
    )
    checks.push('A page the host filters to nothing does not end a topic read.')

    // A recalled message leaves the panel on the next complete read.
    await larkSays({
      op: 'recall',
      text: 'The deploy script still points at staging.',
    })
    await panel.getByRole('button', { name: 'All sessions' }).click()
    await panel.getByRole('button', { name: /Check the deploy script/ }).click()
    await panel
      .locator('[data-role="assistant"]')
      .getByText('The deploy script still points at staging.', { exact: true })
      .waitFor({ state: 'detached', timeout: 30_000 })
    checks.push('A message recalled in Lark leaves the topic on the next read.')
    await panel.getByRole('button', { name: 'All sessions' }).click()

    // A topic that cannot start after the signed message reached Lark: re-read and say
    // so, restore nothing, and never resend on its own.
    const signedCopies = (text: string) =>
      page.evaluate(
        async ({ chatId, text }) => {
          const project = (await window.vela.projects()).find(
            (item) => item.channel === 'lark' && item.id === chatId,
          )!
          const listing = await window.vela.larkMessages({
            chatId,
            sessionId: project.sessionId,
          })
          return listing.messages.filter(
            (message) => message.text === `Vela app: ${text}`,
          ).length
        },
        { chatId: larkProject, text },
      )
    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await larkSays({ op: 'failNextTopicStart' })
    await sendIn(page, 'Message Vela', 'A question that will not start a topic')
    await page.getByRole('heading', { name: 'Vela dev', exact: true }).waitFor()
    const posted = page.getByRole('alert')
    await posted.waitFor({ timeout: 30_000 })
    const postedText = (await posted.textContent()) ?? ''
    assert(
      postedText.includes('Vela posted it in the group'),
      `The page says the message is in the group: ${postedText}`,
    )
    assert(
      postedText.includes('check the group'),
      `The page says where to check: ${postedText}`,
    )
    assert.equal(
      await page.getByLabel('Message Vela in this group').inputValue(),
      '',
      'A posted send does not restore the draft',
    )
    assert.equal(
      await signedCopies('A question that will not start a topic'),
      1,
      'Exactly one signed copy reached the group',
    )
    const afterTopic = await page.evaluate(
      (chatId) => window.vela.sessions('lark', chatId),
      larkProject,
    )
    assert(
      !afterTopic.some(
        (session) =>
          session.topic &&
          session.task === 'A question that will not start a topic',
      ),
      'A topic that did not start has no session',
    )
    assert.equal(
      await panel
        .getByText('A question that will not start a topic', { exact: true })
        .count(),
      0,
      'The panel invented no session for the failed topic',
    )
    checks.push(
      'A topic that fails after the bot posted re-reads the group, says the message is there, keeps no draft and opens no session.',
    )
    await themes(page, 'lark-journey-posted')

    // A send with no receipt: the same re-read, and the draft is not offered again.
    await larkSays({ op: 'failNextSend' })
    await sendIn(
      page,
      'Message Vela in this group',
      'A question with no send receipt',
    )
    const uncertain = page.getByRole('alert').filter({
      hasText: 'may have been posted',
    })
    await uncertain.waitFor({ timeout: 30_000 })
    assert(
      ((await uncertain.textContent()) ?? '').includes('check the group'),
      'The page says where to check',
    )
    assert.equal(
      await page.getByLabel('Message Vela in this group').inputValue(),
      '',
      'An uncertain send does not restore the draft',
    )
    assert.equal(
      await signedCopies('A question with no send receipt'),
      1,
      'The signed message is in the group once',
    )
    const composerForm = page.locator('form').filter({
      has: page.getByLabel('Message Vela in this group'),
    })
    assert.equal(
      await composerForm.getByRole('button', { name: 'Send' }).isDisabled(),
      true,
      'An empty composer cannot resend',
    )
    await Bun.sleep(300)
    assert.equal(
      await signedCopies('A question with no send receipt'),
      1,
      'Nothing resent the message',
    )
    checks.push(
      'A send with no receipt re-reads the group, says it may have been posted, keeps no draft and does not resend.',
    )
    await themes(page, 'lark-journey-uncertain')

    // A waiting topic joins Home's Needs you, and an answer clears it.
    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await sendIn(page, 'Message Vela', 'Ask me which colour to use')
    await page.getByRole('heading', { name: 'Vela dev', exact: true }).waitFor()
    await waitForSessionState(
      page,
      larkProject,
      'Ask me which colour to use',
      'waiting',
      30_000,
      'lark',
    )
    await panel
      .getByRole('region', { name: 'Needs you' })
      .getByRole('button', { name: /Ask me which colour to use/ })
      .waitFor()
    checks.push('The panel lists the waiting Lark topic under Needs you.')
    await page.getByRole('button', { name: 'Home', exact: true }).click()
    const need = page.getByRole('button', {
      name: /Which colour should I use\?/,
    })
    await need.waitFor({ timeout: 30_000 })
    const needText = (await need.textContent()) ?? ''
    assert(needText.includes('Ask me which colour to use'), needText)
    assert(needText.includes('Vela dev'), needText)
    assert(needText.includes('Lark'), needText)
    checks.push(
      'Home leads with the waiting Lark topic, naming its project and tag.',
    )
    await need.click()
    await page.getByRole('heading', { name: 'Vela dev', exact: true }).waitFor()
    await panel
      .getByRole('heading', { name: 'Ask me which colour to use', exact: true })
      .waitFor()
    await panel.getByText('Waiting for an answer', { exact: true }).waitFor()
    await panel
      .getByText('Which colour should I use?', { exact: true })
      .waitFor()
    checks.push('Opening it from Home shows the question in its topic.')
    await waitForIdle(
      page,
      (
        await waitForSessionState(
          page,
          larkProject,
          'Ask me which colour to use',
          'waiting',
          30_000,
          'lark',
        )
      ).sessionId,
      30_000,
      'lark',
    )
    await sendIn(page, 'Message Vela in this topic', 'Blue')
    await panel
      .getByText('Blue it is.', { exact: true })
      .waitFor({ timeout: 30_000 })
    await waitForSessionState(
      page,
      larkProject,
      'Ask me which colour to use',
      'done',
      30_000,
      'lark',
    )
    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await page.getByText('Nothing needs you right now.').waitFor()
    assert.equal(
      await page
        .getByRole('button', { name: /Which colour should I use\?/ })
        .count(),
      0,
    )
    checks.push(
      'Answering the waiting topic in the app clears it from Home and finishes it.',
    )

    // A group nobody has written in yet finishes its first read: the page shows its
    // empty state and composer instead of a loading placeholder forever.
    await sidebar.getByRole('button', { name: 'Vela empty Lark' }).click()
    await page
      .getByRole('heading', { name: 'Vela empty', exact: true })
      .waitFor()
    await page.getByLabel('Message Vela in this group').waitFor({
      timeout: 30_000,
    })
    await page.getByText(/Ask Vela a short question here/).waitFor()
    assert.equal(
      await page.locator('[aria-busy="true"]').count(),
      0,
      'The empty group left its loading state',
    )
    checks.push(
      'A group with no messages shows its empty state and composer on the first open.',
    )
    await themes(page, 'lark-journey-empty')

    // A first read that fails leaves the loading state too, with its reason on screen.
    await larkSays({ op: 'failNextGroupHistory' })
    await sidebar.getByRole('button', { name: 'Vela deny Lark' }).click()
    await page
      .getByRole('heading', { name: 'Vela deny', exact: true })
      .waitFor()
    await page
      .getByRole('alert')
      .filter({ hasText: 'Fake Lark dropped the group history read' })
      .waitFor({ timeout: 30_000 })
    await page.getByLabel('Message Vela in this group').waitFor()
    assert.equal(
      await page.locator('[aria-busy="true"]').count(),
      0,
      'The failed first read left its loading state',
    )
    // The next read is a normal one and shows the group.
    await sidebar.getByRole('button', { name: 'Home', exact: true }).click()
    await sidebar.getByRole('button', { name: 'Vela deny Lark' }).click()
    await page
      .getByText('Deny message 1 of the sixth group.', { exact: true })
      .waitFor({ timeout: 30_000 })
    checks.push(
      'A group whose first read fails shows the reason and the composer, and reads normally after that.',
    )

    // An older page that lands while a refresh reads is not dropped when the refresh
    // applies: the refresh merges into what the page shows now, not into its snapshot.
    await sidebar.getByRole('button', { name: 'Vela race Lark' }).click()
    await page
      .getByRole('heading', { name: 'Vela race', exact: true })
      .waitFor()
    await page
      .getByText('Race message 160 of the seventh group.', { exact: true })
      .waitFor({ timeout: 30_000 })
    assert.equal(
      await page
        .getByText('Race message 60 of the seventh group.', { exact: true })
        .count(),
      0,
      'The first page is the newest 50 messages',
    )
    const refreshedText = 'The delayed refresh has updated the newest message.'
    await larkSays({
      op: 'holdGroupRefresh',
      chatId: raceProject,
      refreshedText,
    })
    await page.getByRole('button', { name: 'Show earlier messages' }).click()
    await sidebar.getByRole('button', { name: 'Home', exact: true }).click()
    await sidebar.getByRole('button', { name: 'Vela race Lark' }).click()
    await page
      .getByRole('heading', { name: 'Vela race', exact: true })
      .waitFor()
    const olderRaceMessage = page.getByText(
      'Race message 61 of the seventh group.',
      { exact: true },
    )
    await olderRaceMessage.waitFor({ timeout: 30_000 })
    await larkSays({ op: 'releaseGroupRefresh' })
    await page
      .getByText(refreshedText, { exact: true })
      .waitFor({ timeout: 30_000 })
    assert.equal(
      await olderRaceMessage.isVisible(),
      true,
      'The older page is still visible after the refresh marker appears',
    )
    checks.push(
      'An older page that arrives during a refresh stays on the page when the refresh applies.',
    )

    // The group is visible, but its previously opened topic is not.
    await sidebar.getByRole('button', { name: 'Vela dev Lark' }).click()
    await page.getByRole('heading', { name: 'Vela dev', exact: true }).waitFor()
    await page
      .getByText('The retry test now covers a 429.', { exact: true })
      .waitFor()
    await larkSays({ op: 'recordHistoryReads' })
    const historyReads = resolve(larkDir, 'history-reads.log')
    await Bun.write(historyReads, '')
    // Wait for the UI's subscription to observe each real Lark history event.
    const observe = (chatId: string, sessionId?: string) =>
      page.evaluate(
        ({ chatId, sessionId }) => {
          const observed = new Promise<void>((resolve, reject) => {
            let changes = 0
            const timer = window.setTimeout(() => {
              off()
              reject(new Error('Lark did not send both history changes'))
            }, 15_000)
            const off = window.vela.onEvent((event) => {
              if (
                event.type !== 'lark' ||
                event.value.type !== 'history_changed' ||
                event.value.chatId !== chatId ||
                event.value.sessionId !== sessionId
              )
                return
              if (++changes < 2) return
              window.clearTimeout(timer)
              off()
              resolve()
            })
          })
          Object.assign(window, { observedHistoryChange: observed })
        },
        { chatId, sessionId },
      )
    const seen = () =>
      page.evaluate(
        () =>
          (window as Window & { observedHistoryChange?: Promise<void> })
            .observedHistoryChange,
      )
    await observe(gapProject)
    await larkSays({
      op: 'say',
      chatId: gapProject,
      text: 'Message in the unopened group',
    })
    await seen()
    await observe(larkProject, topic.sessionId)
    await larkSays({
      op: 'say',
      chatId: larkProject,
      threadId: threadIdent.threadId,
      text: 'Message in the unopened topic',
    })
    await seen()
    const loggedReads = Bun.file(historyReads)
    const deadline = Date.now() + 10_000
    while (
      !(await loggedReads.text()).includes(`group:${larkProject}\n`) &&
      Date.now() < deadline
    )
      await Bun.sleep(20)
    assert(
      (await loggedReads.text()).includes(`group:${larkProject}\n`),
      'The open group is refreshed',
    )
    const reads = await loggedReads.text()
    assert(
      !reads.includes(`group:${gapProject}\n`),
      'No reads for an unopened group',
    )
    assert(
      !reads.includes(`topic:${threadIdent.threadId}\n`),
      'No reads for an unopened topic',
    )
    checks.push(
      'Live Lark history reads are limited to the open group and topic.',
    )

    // Switching projects and sessions in one running app, with no reload.
    await page.evaluate(() => {
      Object.assign(window, { switchedWithoutReload: true })
    })
    await sidebar.getByRole('button', { name: 'Vela dev Lark' }).click()
    await page
      .getByText('The retry test now covers a 429.', { exact: true })
      .waitFor()
    await panel.getByRole('button', { name: /Check the deploy script/ }).click()
    await panel
      .getByText('I will read the deploy script first.', { exact: true })
      .waitFor()
    await sidebar.getByRole('button', { name: 'New project' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Folder path').fill(larkWorkspace)
    await dialog.getByLabel('Name').fill('Local side')
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page
      .getByRole('heading', { name: 'Local side', exact: true })
      .waitFor()
    await sendIn(
      page,
      'Message Vela in this project',
      'A question on the Local side',
    )
    await page
      .getByText('Local answer in the same window.', { exact: true })
      .waitFor({ timeout: 30_000 })
    checks.push('A Local project works in the same window as a Lark one.')
    await sidebar.getByRole('button', { name: 'Vela dev Lark' }).click()
    await page
      .getByText('The retry test now covers a 429.', { exact: true })
      .waitFor()
    // Opening a project shows its session list; the topic opens from there.
    await panel.getByRole('button', { name: /Check the deploy script/ }).click()
    await panel
      .getByText('I will read the deploy script first.', { exact: true })
      .waitFor()
    await sidebar.getByRole('button', { name: 'Local side Local' }).click()
    await page
      .getByText('A question on the Local side', { exact: true })
      .waitFor()
    assert.equal(
      await page.evaluate(
        () =>
          (window as Window & { switchedWithoutReload?: boolean })
            .switchedWithoutReload,
      ),
      true,
      'The window never reloaded',
    )
    await page.getByText('Lark · on', { exact: true }).waitFor()
    await noOverflow(page)
    await themes(page, 'lark-journey-switch')
    checks.push(
      'Moving between a Lark project, a Local project and their sessions works in one running app, with Lark still on.',
    )
  } finally {
    await lark.close()
  }
}

/**
 * A Lark group that is configured but not connected: the project stays listed, its
 * page says Lark is off, and a Local project keeps answering in the same window.
 */
async function larkOffJourney() {
  const dir = await mkdtemp(resolve(dataParent, 'vela-lark-off-'))
  larkOffData = dir
  await Bun.write(
    resolve(dir, 'settings.json'),
    JSON.stringify({
      shellPath: shell,
      extensionConfig: { lark: { chats: [larkProject] } },
    }),
  )
  await Bun.write(
    larkOffScenario,
    JSON.stringify({
      responses: [{ text: 'Local answer while Lark is off.' }],
      generate: Array.from({ length: 20 }, () => ({
        text: 'Compacted history',
      })),
    }),
  )
  console.log('Desktop verification: starting the Lark-off journey')
  const app = await launchDev({
    VELA_DIR: dir,
    VELA_MODEL: `faux:${larkOffScenario}`,
    VELA_DESKTOP_LARK: undefined,
    VELA_DESKTOP_LARK_DIR: undefined,
    LARK_APP_ID: '',
    LARK_APP_SECRET: '',
  })
  try {
    const { page } = app
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(new URL('index.html', page.url()).href)
    await page.getByRole('heading', { name: 'Home', exact: true }).waitFor()
    await page.getByText('Lark · off', { exact: true }).waitFor()
    // With no connection the group has no readable name, so it shows its chat id.
    const group = page
      .getByLabel('Sidebar')
      .getByRole('button', { name: `${larkProject} Lark` })
    await group.waitFor()
    checks.push(
      'A configured group with Lark off stays listed by its chat id, and the sidebar says Lark · off.',
    )
    await group.click()
    await page.getByText('Lark is off.', { exact: true }).waitFor()
    await page.getByText(/Local projects keep working/).waitFor()
    assert.equal(
      await page.getByLabel('Message Vela in this group').count(),
      0,
      'A Lark project with no connection offers no composer',
    )
    await themes(page, 'lark-off')
    checks.push(
      'A Lark project while Lark is off says so and offers no composer.',
    )

    await page
      .getByLabel('Sidebar')
      .getByRole('button', { name: 'New project' })
      .click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Folder path').fill(larkWorkspace)
    await dialog.getByLabel('Name').fill('Off Local')
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page
      .getByRole('heading', { name: 'Off Local', exact: true })
      .waitFor()
    await sendIn(page, 'Message Vela in this project', 'Does Local still work?')
    await page
      .getByText('Local answer while Lark is off.', { exact: true })
      .waitFor({ timeout: 30_000 })
    await page.getByText('Lark · off', { exact: true }).waitFor()
    checks.push(
      'With Lark off, a Local project still answers in the same window.',
    )

    // A send to the group is refused before anything is posted: the reason shows and
    // the draft comes back (the `not-sent` outcome, never a resend).
    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await pick(
      page,
      page.getByRole('combobox', { name: 'Project', exact: true }),
      `${larkProject} · Lark`,
    )
    const homeComposer = page.getByLabel('Message Vela', { exact: true })
    await homeComposer.fill('A question while Lark is off')
    await page.getByRole('button', { name: 'Send' }).click()
    const refused = page.getByRole('alert')
    await refused.waitFor({ timeout: 30_000 })
    assert(
      ((await refused.textContent()) ?? '').includes('Lark is not connected'),
      'The refusal carries the host reason',
    )
    // The composer clears on submit and puts the text back when the send is refused.
    await page.waitForFunction(
      (text) =>
        document.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Message Vela"]',
        )?.value === text,
      'A question while Lark is off',
      { timeout: 5_000 },
    )
    checks.push('A message that was not sent keeps its draft in the composer.')
    assert.deepEqual(
      await page.evaluate(
        (chatId) => window.vela.sessions('lark', chatId),
        larkProject,
      ),
      [],
      'The refused send created no session',
    )
    checks.push(
      'A send to a Lark project while Lark is off shows the reason and returns its draft.',
    )
    await noOverflow(page)
  } finally {
    await app.close()
  }
}

/** Journeys 4 and 5 end by starting the app again on the same scratch data. */
async function restartJourney() {
  console.log('Desktop verification: restarting Electron')
  const second = await launchDev()
  try {
    const { page } = second
    await page.setViewportSize({ width: 1280, height: 800 })
    // The development window opens the specimen first; the product entry is index.html.
    await page.goto(new URL('index.html', page.url()).href)
    await page.getByRole('heading', { name: 'Home', exact: true }).waitFor()
    const sidebar = page.getByLabel('Sidebar')
    for (const name of ['Alpha', 'Beta'])
      await sidebar.getByRole('button', { name: `${name} Local` }).waitFor()
    await sidebar.getByRole('button', { name: 'Beta Local' }).click()
    await page
      .getByText('What is in Beta?', { exact: true })
      .waitFor({ timeout: 30_000 })
    await page.getByText('Beta answer', { exact: true }).waitFor()
    await sidebar.getByRole('button', { name: 'Alpha Local' }).click()
    await page
      .getByRole('heading', { name: 'Alpha', exact: true })
      .waitFor({ timeout: 30_000 })
    checks.push(
      'After a restart the same data directory brings back both projects and their conversations.',
    )
    await snapshot(page, 'journey-4-restart')

    // Journey 5: the cancelled routine stays gone, the other one keeps its next run.
    await sidebar.getByRole('button', { name: 'Routines' }).click()
    await page.getByRole('heading', { name: 'Routines', exact: true }).waitFor()
    const alphaGroup = page
      .locator('main')
      .getByRole('region', { name: 'Alpha' })
    const alpha = await projectNamed(page, 'Alpha')
    const remaining = (await routinesIn(page, alpha.id)).routines
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0]?.message, 'Check the CI log')
    await alphaGroup.getByText('Check the CI log', { exact: true }).waitFor()
    assert.equal(
      await alphaGroup.getByText('Review the report', { exact: true }).count(),
      0,
      'The cancelled routine stayed cancelled',
    )
    await alphaGroup
      .getByText(`Next: ${remaining[0]!.nextRun}`, { exact: true })
      .waitFor()
    await snapshot(page, 'journey-5-restart')
    checks.push(
      'After a restart a cancelled routine is still gone and the kept one has its next run.',
    )
  } finally {
    await second.close()
  }
}

async function packagedLarkProject(executablePath: string) {
  const agentDir = resolve(scratch, 'packaged-lark-data')
  const chatId = 'oc_packaged'
  await mkdir(agentDir)
  await Bun.write(
    resolve(agentDir, 'settings.json'),
    JSON.stringify({ extensionConfig: { lark: { chats: [chatId] } } }),
  )
  const app = await _electron.launch({
    executablePath,
    args: [`--user-data-dir=${resolve(scratch, 'packaged-lark-profile')}`],
    env: { ...env, VELA_DIR: agentDir },
    timeout: 30_000,
  })
  try {
    const page = await app.firstWindow()
    watch(page)
    await page.getByRole('heading', { name: 'VELA', exact: true }).waitFor()
    const observed = await page.evaluate(async () => ({
      settings: await window.vela.settings(),
      connection: await window.vela.connection('lark'),
      projects: await window.vela.projects(),
    }))
    assert.deepEqual(observed.settings.lark.chats, [chatId])
    assert.equal(observed.connection.connected, false)
    assert.deepEqual(
      observed.projects
        .filter((project) => project.channel === 'lark')
        .map((project) => project.id),
      [chatId],
      'The packaged host lists the configured Lark project with no credentials',
    )
    checks.push(
      'The packaged host lists the configured Lark project with no credentials.',
    )
  } finally {
    await app.close()
  }
}

async function packaged(appPath: string) {
  const appRoot = resolve(appPath)
  const resources = resolve(
    appRoot,
    process.platform === 'darwin' ? 'Contents/Resources' : 'resources',
  )
  const executablePath = resolve(
    appRoot,
    process.platform === 'darwin' ? 'Contents/MacOS/Vela' : 'Vela',
  )
  await packagedLarkProject(executablePath)
  const app = await _electron.launch({
    executablePath,
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
    await page.setViewportSize({ width: 1280, height: 800 })
    await bridgeJourney(page)
    await journeyOne(page, app)
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
        licenses.includes('LICENSE.md'),
    )
    assert(
      (
        await readFile(resolve(resources, 'Barlow-LICENSE.txt'), 'utf8')
      ).includes('SIL OPEN FONT LICENSE'),
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
async function groupDiscoveryJourney() {
  await verifyLarkDiscovery(scratch, launchDev, themes, sendIn)
  checks.push(
    'Settings Off refuses discovery and preserves a running Local turn. After Settings On, New project lists enabled groups, cancels without writing, protects running sessions, and saves only the confirmed new group.',
  )
}
try {
  const option = process.argv.indexOf('--packaged')
  if (option >= 0) {
    const path = process.argv[option + 1]
    assert(path, 'Pass the packaged .app path')
    await packaged(resolve(root, '../..', path))
  } else if (process.env.VELA_DESKTOP_VERIFY_LARK_DISCOVERY === '1') {
    await groupDiscoveryJourney()
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
  if (firstRunData) await rm(firstRunData, { recursive: true, force: true })
  if (larkData) await rm(larkData, { recursive: true, force: true })
  if (larkOffData) await rm(larkOffData, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
}
