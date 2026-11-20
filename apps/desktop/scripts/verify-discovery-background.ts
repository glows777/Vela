import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright'

/** Hold a real SDK background command past its originating turn, then release it from the driver. */
export async function verifyDiscoveryWithBackgroundWork(
  scratch: string,
  launch: (
    env: Record<string, string>,
  ) => Promise<{ page: Page; close(): Promise<void> }>,
) {
  const dir = await mkdtemp(join(scratch, 'group-background-'))
  const fake = join(dir, 'fake')
  await mkdir(join(fake, 'discovery'), { recursive: true })
  const settings = join(dir, 'settings.json')
  const original = JSON.stringify({
    extensionConfig: { lark: { chats: ['oc_existing'] } },
  })
  await Bun.write(settings, original)
  await Bun.write(
    join(fake, 'seed.json'),
    JSON.stringify({ chats: { oc_existing: { name: 'Existing group' } } }),
  )
  const scenario = join(dir, 'faux.json')
  await Bun.write(
    scenario,
    JSON.stringify({
      responses: [
        {
          toolCalls: [
            {
              name: 'bash',
              input: {
                run_in_background: true,
                command:
                  'touch "$JOB_STARTED"; while [ ! -f "$JOB_RELEASE" ]; do sleep 0.1; done; echo "job output survived"',
              },
            },
          ],
        },
        { text: 'The command is running in the background.' },
        { text: 'The command result arrived.' },
      ],
    }),
  )
  const started = join(dir, 'started')
  const release = join(dir, 'release')
  const app = await launch({
    VELA_DIR: dir,
    VELA_MODEL: `faux:${scenario}`,
    VELA_DESKTOP_LARK: 'fake',
    VELA_DESKTOP_LARK_DIR: fake,
    VELA_DESKTOP_VERIFY_BACKGROUND: '1',
    LARK_APP_ID: 'cli_desktop_fake',
    LARK_APP_SECRET: 'test-only',
    JOB_STARTED: started,
    JOB_RELEASE: release,
  })
  try {
    const { page } = app
    await page.goto(new URL('index.html', page.url()).href)
    const sidebar = page.getByLabel('Sidebar')
    await sidebar.getByRole('button', { name: 'Existing group Lark' }).click()
    const chat = page.getByLabel('Project chat')
    await Bun.write(
      join(fake, 'control.jsonl'),
      `${JSON.stringify({ op: 'say', chatId: 'oc_existing', text: 'Start the background command' })}\n`,
    )
    await chat
      .getByText('The command is running in the background.', { exact: true })
      .waitFor()
    assert(
      await Bun.file(started).exists(),
      'The scratch command actually started',
    )
    const deadline = Date.now() + 30000
    while (
      (await page.evaluate(() => window.vela.sessions('lark'))).some(
        (s) => s.runId,
      )
    ) {
      assert(Date.now() < deadline, 'Initiating turn did not finish')
      await Bun.sleep(50)
    }
    assert.equal(await Bun.file(release).exists(), false)
    console.log(
      'Background fixture: command started, initiating turn finished, release marker absent.',
    )
    await sidebar.getByRole('button', { name: 'New project' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('tab', { name: 'Lark' }).click()
    await dialog.getByRole('button', { name: 'Add a group' }).click()
    // If a restart is wrongly admitted, the real discovery callback returns this candidate.
    await Bun.write(
      join(fake, 'discovery/control.jsonl'),
      `${JSON.stringify({ op: 'say', chatId: 'oc_candidate', text: 'Mention' })}\n`,
    )
    const refusal = dialog.getByRole('alert')
    const approval = dialog.getByRole('button', { name: 'Enable group' })
    await refusal.or(approval).first().waitFor()
    assert(
      await refusal.isVisible(),
      'Discovery disposed the host and reached approval while its background command was still running',
    )
    assert.match(await refusal.innerText(), /background command/i)
    assert.equal(await readFile(settings, 'utf8'), original)
    await dialog.getByRole('button', { name: 'Close dialog' }).click()
    await Bun.write(release, 'finish')
    await chat
      .getByText('The command result arrived.', { exact: true })
      .waitFor()
    let recorded = false
    for await (const file of new Bun.Glob('**/transcript.jsonl').scan(dir)) {
      const lines = (await Bun.file(join(dir, file)).text()).split('\n')
      if (
        lines.some(
          (line) =>
            line.includes('finished with exit code 0') &&
            line.includes('job output survived'),
        )
      )
        recorded = true
    }
    assert(
      recorded,
      'The original command finished and delivered its actual output to its session',
    )
  } finally {
    await Bun.write(release, 'finish')
    await app.close()
  }
}
