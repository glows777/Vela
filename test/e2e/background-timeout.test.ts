import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { fauxText, fauxToolCall } from '@glows777/vela/testing'
import { background } from '../../packages/vela/src/driver/extensions/background/index.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

setDefaultTimeout(20_000)

afterEach(cleanupTestVelas)

async function until(
  check: () => boolean | Promise<boolean>,
  what = 'condition',
) {
  const deadline = Date.now() + 5000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

test('foreground bash honors explicit timeout and hard-kills without moving to background', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'printf "partial\\n"; sleep 5',
        timeout: 0.3,
      }),
      fauxText('Timed out cleanly.'),
    ],
    extensions: [background()],
  })
  await t.run('run a slow foreground command')
  const result = t.model.calls[1]!.toolResults[0]!
  expect(result.output).toContain('Command timed out after 0.3 seconds')
  expect(result.raw).toMatchObject({ type: 'error-text' })
  expect(await t.session.backgroundTasks()).toEqual([])
})

test('run_in_background with explicit timeout stops the job and delivers a time-limit notice', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'echo STARTED; sleep 5',
        run_in_background: true,
        timeout: 0.3,
      }),
      fauxText('Started it.'),
      (request) => {
        expect(request.lastUserText).toContain(
          'Background command "bg-1" was stopped after reaching its background time limit.',
        )
        return fauxText('It was stopped.')
      },
    ],
    extensions: [background()],
  })
  await t.run('start it in the background')
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain(
    'Command running in background with ID: bg-1.',
  )
  await until(() => t.model.calls.length === 3, 'the stop delivery')
  expect(t.lastAssistantText()).toBe('It was stopped.')
})

test('manual backgroundTasks moves a running foreground command and delivers its exit', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', { command: 'echo FIRST; sleep 1.2; echo END' }),
      fauxText('Moved it.'),
      (request) => fauxText(request.lastUserText),
    ],
    extensions: [background()],
  })
  const running = t.run('start the check')
  await until(
    () => t.eventsOf('tool_execution_update').length > 0,
    'the running call to produce output',
  )
  expect(await t.session.backgroundTasks('faux-call-1-1')).toEqual(['bg-1'])
  await running
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain(
    'Command was manually moved to the background with ID: bg-1.',
  )
  await until(() => t.model.calls.length === 3, 'the exit turn')
  expect(await t.session.backgroundTasks()).toEqual([])
  expect(t.model.calls[2]!.lastUserText).toStartWith(
    'Background command bg-1 finished with exit code 0.',
  )
  expect(t.model.calls[2]!.lastUserText).toContain('\nEND\n')
  const { openDatabase } = await import('../../packages/vela/src/db/index.ts')
  const db = openDatabase({ path: `${t.dataDir}/vela.db`, readonly: true })
  try {
    const row = db.get<{ status: string; details_json: string | null }>(
      'SELECT status, details_json FROM vela_tool_calls ORDER BY created_at DESC LIMIT 1',
    )
    expect(row?.status).toBe('completed')
    expect(row?.details_json).toContain('bg-1')
  } finally {
    db.close()
  }
})
