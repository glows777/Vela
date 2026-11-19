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
const beta = resolve(scratch, 'beta')
const scenario = resolve(scratch, 'faux.json')
const shell = resolve(scratch, 'shell')
const shellMarker = resolve(scratch, 'shell-used')
const badConfig = process.env.VELA_DESKTOP_VERIFY_BAD_CONFIG === '1'
const disabledConfig = process.env.VELA_DESKTOP_VERIFY_DISABLED === '1'
await Promise.all(
  [home, data, profile, project, alpha, beta].map((path) =>
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
      { text: 'Alpha answer' },
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

  const alphaProject = await projectNamed(page, 'Alpha')
  await waitForIdle(page, alphaProject.sessionId)
  await page.getByRole('button', { name: 'Home', exact: true }).click()
  assert.equal(
    await page.getByLabel('Project', { exact: true }).inputValue(),
    alphaProject.id,
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
  await page.getByRole('alert').waitFor()
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
    'A submission the host rejects shows the error, restores the draft and records no message.',
  )
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
const waitForIdle = async (page: Page, sessionId: string, timeout = 30_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const sessions = await page.evaluate(() => window.vela.sessions('local'))
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
) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const sessions = await page.evaluate(
      (projectId) => window.vela.sessions('local', projectId),
      projectId,
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
  assert.equal(
    await panel.getByText(/Check the error above/).count(),
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
  await panel.getByText(/Task failed: invalid api key/).waitFor({
    timeout: 30_000,
  })
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
/** One development Electron, from Forge start to a closed process. */
async function launchDev() {
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
  const first = await launchDev()
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
  } finally {
    await first.close()
  }
  await restartJourney()
}

/** Journey 4's second half: the app starts again on the same scratch data. */
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
  } finally {
    await second.close()
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
    await page.setViewportSize({ width: 1280, height: 800 })
    await bridgeJourney(page)
    await journeyOne(page)
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
