import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { createVela } from '@glows777/vela'
import { createFauxModel, tempDir } from '@glows777/vela/testing'
import { createLocalExecutionEnv } from '../../packages/vela/src/driver/execution/local.ts'
import { background } from '../../packages/vela/src/driver/extensions/background/index.ts'
import type { ExecutionEnv } from '../../packages/vela/src/driver/index.ts'
import {
  fauxText,
  fauxToolCall,
} from '../../packages/vela/src/testing/core/index.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

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

test('bash run_in_background returns at once with its id, then the exit starts its own turn', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'sleep 0.5; echo READY > ready.txt; echo READY',
        run_in_background: true,
      }),
      () => {
        // The tool result arrived while the command still sleeps, so the turn continued.
        expect(existsSync(t.path('ready.txt'))).toBe(false)
        return fauxText('Started the slow check.')
      },
      fauxText('The check finished.'),
    ],
    extensions: [background()],
  })
  await t.run('start the slow check')
  await until(() => t.model.calls.length === 3, 'the exit turn')
  await until(() => !t.session.isRunning, 'the delivery run to settle')
  const started = t.model.calls[1]!.toolResults[0]!.output
  expect(started).toContain('Command running in background with ID: bg-1.')
  expect(started).toContain(
    'You will be notified when it completes; do not poll the file or start a second copy.',
  )
  // The delivery starts its own turn with the exit state and the tail.
  const delivery = t.model.calls[2]!.lastUserText
  expect(delivery).toStartWith(
    'Background command bg-1 finished with exit code 0.',
  )
  expect(delivery).toContain('READY')
  const { openDatabase } = await import('../../packages/vela/src/db/index.ts')
  const db = openDatabase({ path: `${t.dataDir}/vela.db`, readonly: true })
  try {
    const row = db.get<{ details_json: string | null }>(
      'SELECT details_json FROM vela_tool_calls ORDER BY created_at DESC LIMIT 1',
    )
    expect(row?.details_json).toContain('bg-1')
  } finally {
    db.close()
  }
})

test('a long background command spills in the session environment, and read pages it', async () => {
  let log = ''
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', { command: 'seq 1 20000', run_in_background: true }),
      () => fauxText('Started it.'),
      fauxText('It finished.'),
      () => fauxToolCall('read', { path: log, offset: 1, limit: 3 }),
      (request) => {
        expect(request.toolResults[0]!.output).toStartWith('1\n2\n3\n')
        return fauxToolCall('read', { path: log, offset: 20000, limit: 3 })
      },
      (request) => {
        expect(request.toolResults[0]!.output).toBe('20000\n')
        return fauxText('Read the whole log.')
      },
    ],
    extensions: [background()],
  })
  await t.run('start the noisy command')
  await until(() => t.model.calls.length === 3, 'the exit turn')
  await until(() => !t.session.isRunning, 'the delivery run to settle')
  // The start reports the id and the tail it has; it never points at a log that is still empty.
  const started = t.model.calls[1]!.toolResults[0]!.output
  expect(started).toContain('Command running in background with ID: bg-1.')
  expect(started).not.toContain('Full output')
  // The tail the model reads is bounded to the last 2,000 lines; the exit delivery names the file.
  const delivery = t.model.calls[2]!.lastUserText
  expect(delivery).toContain('\n18001\n')
  expect(delivery).not.toContain('\n1\n')
  log = /Full output: (\S+)/.exec(delivery)![1]!
  // The file is the environment's own spill file, inside the session, so read pages all of it.
  expect(log).toStartWith(t.session.registry.spillDir!)
  expect(await Bun.file(log).text()).toEndWith('20000\n')
  expect((await Bun.file(log).text()).split('\n').length).toBe(20001)
  await t.run('read the log')
  expect(t.model.calls.length).toBe(6)
})

test('an adapter that only implements the published contract gets its own log named on exit', async () => {
  const dir = tempDir()
  // A host adapter written against today's `ExecutionEnv`: it forwards `onOutput` and keeps its own
  // spill file, which it can name only once the command has finished.
  const hostEnv = (cwd: string): ExecutionEnv => {
    const base = createLocalExecutionEnv({ cwd })
    const adapter: ExecutionEnv = Object.create(base)
    adapter.exec = async (command, options, signal) => {
      let collected = ''
      const result = await base.exec(
        command,
        {
          ...options,
          spill: undefined,
          onOutput: (chunk, chunkSignal, info) => {
            collected += chunk
            options?.onOutput?.(chunk, chunkSignal, info)
          },
        },
        signal,
      )
      const full = await base.createTempFile(
        { prefix: 'adapter-', suffix: '.log' },
        signal,
      )
      if (!result.ok || !full.ok) return result
      await base.writeFile(full.value, collected, signal)
      return { ok: true, value: { ...result.value, spillPath: full.value } }
    }
    return adapter
  }
  let log = ''
  const model = createFauxModel({
    responses: [
      fauxToolCall('bash', { command: 'seq 1 20000', run_in_background: true }),
      fauxText('Started it.'),
      fauxText('The command finished.'),
      () => fauxToolCall('read', { path: log, offset: 1, limit: 2 }),
      (request) => {
        expect(request.toolResults[0]!.output).toStartWith('1\n2\n')
        return fauxText('Read the adapter log.')
      },
    ],
  })
  const vela = createVela({
    cwd: dir.path,
    dataDir: '.data',
    model,
    extensions: [background()],
    env: ({ location }) => hostEnv(location.cwd),
  })
  try {
    const session = vela.session('adapter')
    await session.prompt('start the noisy command')
    await until(() => model.calls.length === 3, 'the exit turn')
    // The start names the job and its tail, never a file that is still empty.
    const started = model.calls[1]!.toolResults[0]!.output
    expect(started).toContain('Command running in background with ID: bg-1.')
    expect(started).not.toContain('Full output')
    // The exit notification names the file the adapter spilled to, not one the session created.
    const delivery = model.calls[2]!.lastUserText
    expect(delivery).toContain('Background command bg-1 finished')
    log = /Full output: (\S+)/.exec(delivery)?.[1] ?? ''
    expect(log).toContain('adapter-')
    expect((await Bun.file(log).text()).trimEnd().split('\n')).toHaveLength(
      20000,
    )
    // The exit started its own turn; wait for it to settle before prompting again.
    await until(() => !session.isRunning, 'the delivery run to settle')
    await session.prompt('read the adapter log')
    expect(model.calls.at(-1)!.toolResults[0]!.output).toStartWith('1\n2\n')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('a background command with no output says so and names no file', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', { command: 'true', run_in_background: true }),
      fauxText('Started the quiet check.'),
      (request) => {
        expect(request.lastUserText).toContain('Output:\n(no output)')
        // Nothing spilled, so there is no log to point at.
        expect(request.lastUserText).not.toContain('Full output')
        return fauxText('The quiet check finished.')
      },
    ],
    extensions: [background()],
  })
  await t.run('start the quiet check')
  await until(() => t.model.calls.length === 3, 'the exit turn')
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain(
    'Command running in background with ID: bg-1.',
  )
})

test('without the background extension bash refuses run_in_background and starts nothing', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'touch marker; echo RAN',
        run_in_background: true,
      }),
      (request) => {
        expect(request.toolResults[0]!.output).toContain(
          'Background commands are not enabled in this session',
        )
        return fauxText('It is not enabled.')
      },
    ],
  })
  await t.run('start it in the background')
  expect(existsSync(t.path('marker'))).toBe(false)
})

test('/tasks and /bashes list running jobs with their tails, stop ends them, and the footer status follows', async () => {
  const t = createTestVela({
    responses: [
      [
        fauxToolCall('bash', {
          command: 'echo READY; sleep 30',
          run_in_background: true,
        }),
        fauxToolCall('bash', {
          command: 'echo SECOND; sleep 30',
          run_in_background: true,
        }),
      ],
      fauxText('Started both checks.'),
    ],
    extensions: [background()],
  })
  await t.run('start two slow checks in the background')
  // The calls return at admission; the list shows a tail once the commands write it.
  const latestNotice = () => t.eventsOf('notify').at(-1)?.message ?? ''
  await until(async () => {
    await t.run('/bashes')
    return (
      latestNotice().includes('\n  READY') &&
      latestNotice().includes('\n  SECOND')
    )
  }, 'both jobs to write their output')
  expect(latestNotice()).toMatch(
    /^\[tasks\] 2 background tasks\nbg-1 · running · \d+s · \$ echo READY; sleep 30\n {2}READY\n\nbg-2 · running · \d+s · \$ echo SECOND; sleep 30\n {2}SECOND$/,
  )
  await t.run('/tasks stop bg-1')
  expect(latestNotice()).toMatch(
    /^bg-1 · stopped · \d+s · \$ echo READY; sleep 30\n {2}READY$/,
  )
  await t.run('/tasks stop bg-2')
  expect(latestNotice()).toMatch(
    /^bg-2 · stopped · \d+s · \$ echo SECOND; sleep 30\n {2}SECOND$/,
  )
  await t.run('/tasks')
  expect(latestNotice()).toBe('No background tasks')
  await t.run('/tasks stop bg-1')
  expect(latestNotice()).toContain('Unknown background command bg-1.')
  expect(latestNotice()).toContain(
    'It may have finished and its result was delivered (or returned by background_stop), or it ended with a restart or session close.',
  )
})
