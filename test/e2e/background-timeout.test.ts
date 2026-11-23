import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createVela } from '@glows777/vela'
import { fauxText, fauxToolCall, tempDir } from '@glows777/vela/testing'
import { background } from '../../packages/vela/src/driver/extensions/background/index.ts'
import { loadConfig } from '../../packages/vela/src/driver/index.ts'
import { lark } from '../../packages/vela/src/lark/index.ts'
import { fakeLark, larkEvent } from '../support/lark.ts'
import {
  cleanupTestVelas,
  createTestVela,
  type TestVelaOptions,
} from '../support/vela.ts'

// These tests wait out real seconds: a command has to outlive its budget, then exit.
setDefaultTimeout(20_000)

afterEach(cleanupTestVelas)

const dirs: { cleanup(): void }[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

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

type Extensions = NonNullable<
  NonNullable<Parameters<typeof createVela>[0]>['extensions']
>

/**
 * A test Vela whose settings are a real `settings.json` read by the same `loadConfig()` the CLI
 * uses; user settings so a channel session, which runs in its own workspace, gets the same budget.
 * The built-in `background` extension is loaded the way the CLI loads it, per session location, so
 * the budget reaches `bash` from the settings, not from its options.
 */
function velaWithSettings(
  options: TestVelaOptions,
  settings: Record<string, unknown>,
  hostExtensions: Extensions = [],
  /** What the project loader returns; empty for a session without the `background` extension. */
  builtins: Extensions = [background()],
) {
  const dir = tempDir('vela-budget-')
  dirs.push(dir)
  const agentDir = join(dir.path, 'home')
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(settings))
  const config = loadConfig({ cwd: dir.path, agentDir, trusted: true })
  const split = {
    ...config.sessionResources!,
    projectExtensions: async () => ({
      key: 'fixture',
      extensionConfig: {},
      load: async () => builtins,
    }),
  }
  // A custom assembler replaces the wrapper's extension list, so the host-level extensions under
  // test (a channel listener) are added here instead of through `options.extensions`.
  return createTestVela({ ...options, cwd: dir.path }, (vela) =>
    createVela({
      ...vela,
      extensions: [...(vela.extensions ?? []), ...hostExtensions],
      sessionResources: split,
    }),
  )
}

test('a foreground command past its budget moves to the background and its exit arrives on its own', async () => {
  const t = velaWithSettings(
    {
      responses: [
        fauxToolCall('bash', { command: 'echo STARTED; sleep 2.5; echo END' }),
        fauxText('Kept working while it runs.'),
        (request) => {
          expect(request.lastUserText).toStartWith(
            'Background command bg-1 finished with exit code 0.',
          )
          return fauxText('The command finished.')
        },
      ],
    },
    // Not sub-second: `bash -lc` pays login-shell startup first, so the command needs room to print
    // before its deadline (#372).
    { bashForegroundTimeoutSeconds: 1.5 },
  )
  await t.run('run the slow check')
  // The call returns the notice and the tail so far, not the command's result.
  const moved = t.model.calls[1]!.toolResults[0]!.output
  expect(moved).toStartWith(
    'Command did not complete within its 1.5s timeout and was moved to the background (ID: bg-1).',
  )
  expect(moved).toContain('STARTED')
  expect(moved).toContain(
    'You will be notified when it completes; do not poll the file or start a second copy.',
  )
  expect(moved).not.toContain('END')
  // The log path comes with the exit, once there is one; a move never promises it.
  expect(moved).not.toContain('Full output')
  // Moved, not failed: the model gets a result, and the reason travels in the metadata.
  expect(t.eventsOf('tool_execution_end')[0]).toMatchObject({
    toolName: 'bash',
    isError: false,
  })
  const history = await Bun.file(t.session.registry.results.history.path).text()
  expect(history).toContain('"backgroundTaskId":"bg-1"')
  expect(history).toContain('"timedOutAfterMs":1500')
  expect(history).not.toContain('"backgroundedByUser"')
  // The command kept running: its exit is a separate turn carrying the end of the output.
  await until(() => t.model.calls.length === 3, 'the exit turn')
  expect(t.model.calls[2]!.lastUserText).toContain('\nEND\n')
})

test('a command that starts with sleep keeps the timeout kill and starts no job', async () => {
  const t = velaWithSettings(
    {
      responses: [
        fauxToolCall('bash', { command: 'sleep 5' }),
        fauxText('It stopped.'),
        // A requested timeout is still held to the ceiling on this path, and says so.
        fauxToolCall('bash', { command: 'sleep 5', timeout: 900 }),
        fauxText('It stopped too.'),
      ],
    },
    { bashForegroundTimeoutSeconds: 0.3, bashForegroundTimeoutMaxSeconds: 0.4 },
  )
  await t.run('wait a while')
  const result = t.model.calls[1]!.toolResults[0]!
  expect(result.output).toContain('Command timed out after 0.3 seconds')
  expect(result.output).not.toContain('capped')
  expect(result.raw).toMatchObject({ type: 'error-text' })
  await t.run('wait again')
  expect(t.model.calls[3]!.toolResults[0]!.output).toContain(
    'Command timed out after 0.4 seconds. The requested 900s timeout is capped at 0.4s.',
  )
  expect(await t.session.backgroundTasks()).toEqual([])
})

test('with no foreground budget a command waits as before, while an explicit timeout still kills', async () => {
  const t = velaWithSettings(
    {
      responses: [
        fauxToolCall('bash', { command: 'sleep 0.6; echo done' }),
        fauxText('It finished.'),
        fauxToolCall('bash', {
          command: 'printf "partial\\n"; sleep 5',
          timeout: 0.3,
        }),
        fauxText('It stopped.'),
      ],
    },
    { bashForegroundTimeoutSeconds: 0 },
  )
  await t.run('wait for it')
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain('done')
  // A budget of 0 also keeps the old kill for a `timeout` the model passes itself.
  await t.run('now the other one')
  expect(t.model.calls[3]!.toolResults[0]!.output).toContain(
    'Command timed out after 0.3 seconds',
  )
  expect(await t.session.backgroundTasks()).toEqual([])
})

test('a budget longer than the ceiling is not cut to it, and a shorter requested timeout wins', async () => {
  // The configured budget raises the ceiling (Claude Code's rule), so a session budgeted at 0.6 s
  // keeps all of it even though the ceiling says 0.2 s; the second call asks for less.
  const t = velaWithSettings(
    {
      responses: [
        fauxToolCall('bash', { command: 'echo FIRST; sleep 1' }),
        fauxText('The first one moved.'),
        fauxToolCall('bash', { command: 'echo SECOND; sleep 1', timeout: 0.2 }),
        fauxText('The second one moved.'),
      ],
      allowPendingResponses: true,
    },
    { bashForegroundTimeoutSeconds: 0.6, bashForegroundTimeoutMaxSeconds: 0.2 },
  )
  await t.run('run the first one')
  expect(t.model.calls[1]!.toolResults[0]!.output).toStartWith(
    'Command did not complete within its 0.6s timeout and was moved to the background (ID: bg-1).',
  )
  expect(t.model.calls[1]!.toolResults[0]!.output).not.toContain('capped')
  await t.run('run the second one')
  expect(t.model.calls[3]!.toolResults[0]!.output).toStartWith(
    'Command did not complete within its 0.2s timeout and was moved to the background (ID: bg-2).',
  )
  expect(t.model.calls[3]!.toolResults[0]!.output).not.toContain('capped')
})

test('a session without the background extension keeps the old timeout kill', async () => {
  // No job table at all: the budget cannot be honoured, so it is not applied, and an explicit
  // `timeout` kills the command exactly as before.
  const t = velaWithSettings(
    {
      responses: [
        fauxToolCall('bash', {
          command: 'printf "partial\\n"; sleep 5',
          timeout: 0.3,
        }),
        fauxText('It stopped.'),
      ],
    },
    { bashForegroundTimeoutSeconds: 0.1 },
    [],
    [],
  )
  await t.run('wait for it')
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain(
    'Command timed out after 0.3 seconds',
  )
  expect(t.session.backgroundTasks()).rejects.toThrow(
    'Background commands are not enabled in this session',
  )
})

test('a timeout above the ceiling is clamped and the notice names both values', async () => {
  const t = velaWithSettings(
    {
      responses: [
        fauxToolCall('bash', {
          command: 'echo STARTED; sleep 5',
          timeout: 600,
        }),
        fauxText('It moved.'),
      ],
      allowPendingResponses: true,
    },
    {
      bashForegroundTimeoutSeconds: 0.2,
      bashForegroundTimeoutMaxSeconds: 0.4,
    },
  )
  await t.run('wait a long time')
  expect(t.model.calls[1]!.toolResults[0]!.output).toStartWith(
    'Command did not complete within its 0.4s timeout and was moved to the background (ID: bg-1). The requested 600s timeout is capped at 0.4s.',
  )
  const history = await Bun.file(t.session.registry.results.history.path).text()
  expect(history).toContain('"timedOutAfterMs":400')
})

test('run_in_background with a timeout caps the job and its delivery says it was stopped', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'echo STARTED; sleep 5',
        run_in_background: true,
        timeout: 0.3,
      }),
      fauxText('Started it.'),
      (request) => {
        // Unchanged here: a declared job past its own timeout ends through the environment's error.
        expect(request.lastUserText).toContain(
          'Background command bg-1 could not start or run: timeout.',
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
})

test('a session without background_stop keeps the old behavior: no budget, no automatic move', async () => {
  const t = velaWithSettings(
    {
      responses: [
        fauxToolCall('bash', { command: 'echo STARTED; sleep 1; echo done' }),
        fauxText('It finished.'),
      ],
      // The job table is installed, but the tool that ends a job is not in this session's list.
      session: { tools: ['bash'] },
    },
    { bashForegroundTimeoutSeconds: 0.2 },
  )
  await t.run('wait for it')
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain('done')
  expect(await t.session.backgroundTasks()).toEqual([])
})

test('a user move competing with the deadline still produces exactly one job', async () => {
  const t = velaWithSettings(
    {
      responses: [
        fauxToolCall('bash', { command: 'echo FIRST; sleep 1.5; echo END' }),
        fauxText('Moved it.'),
        (request) => fauxText(request.lastUserText),
      ],
    },
    { bashForegroundTimeoutSeconds: 0.6 },
  )
  const running = t.run('start the check')
  await until(
    () => t.eventsOf('tool_execution_update').length > 0,
    'the running call to produce output',
  )
  expect(await t.session.backgroundTasks('faux-call-1-1')).toEqual(['bg-1'])
  await running
  // The user got there first, so the call reports the manual move and not a budget that expired.
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain(
    'Command was manually moved to the background with ID: bg-1.',
  )
  // Past the deadline the timer finds nothing left to claim: one job, one delivery.
  await until(() => t.model.calls.length === 3, 'the exit turn')
  expect(await t.session.backgroundTasks()).toEqual([])
  expect(t.model.calls[2]!.lastUserText).toStartWith(
    'Background command bg-1 finished with exit code 0.',
  )
  const history = await Bun.file(t.session.registry.results.history.path).text()
  expect(history).toContain('"backgroundedByUser":true')
  expect(history).not.toContain('"timedOutAfterMs"')
})

test('a topic answers "moved to the background", then the exit arrives as a second reply', async () => {
  const fake = fakeLark()
  const t = velaWithSettings(
    {
      responses: [
        fauxToolCall('bash', { command: 'echo STARTED; sleep 1; echo LATE' }),
        (request) => {
          expect(request.toolResults[0]!.output).toContain(
            'Command did not complete within its 0.5s timeout and was moved to the background (ID: bg-1).',
          )
          return fauxText('The check was moved to the background.')
        },
        (request) => {
          expect(request.lastUserText).toContain(
            'Background command bg-1 finished with exit code 0.',
          )
          return fauxText('The check finished.')
        },
      ],
    },
    { bashForegroundTimeoutSeconds: 0.5 },
    [
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  )
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(topicEvent('trigger', 'run the slow check'))
  await until(() => fake.sent.length === 1, 'the first reply')
  await until(() => fake.sent.length === 2, 'the exit reply')
  expect(fake.sent).toEqual([
    {
      messageId: 'trigger',
      text: '<at user_id="ou_alice"></at> The check was moved to the background.',
    },
    // The exit is a new reply in the same topic, anchored to its root message.
    {
      messageId: 'root',
      text: '<at user_id="ou_alice"></at> The check finished.',
    },
  ])
})

const topicEvent = (message_id: string, text: string) =>
  larkEvent({
    message_id,
    root_id: 'root',
    thread_id: 'thread',
    content: JSON.stringify({ text }),
  })
