import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { fauxText, fauxToolCall } from '@glows777/vela-core/testing'
import { background } from '../../packages/core/src/extensions/background/index.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

type TestVela = ReturnType<typeof createTestVela>

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

/** What a user's keypress does while a run is in progress: the session method, once the call has output. */
async function detachWhenRunning(t: TestVela, toolCallId?: string) {
  await until(
    () =>
      t
        .eventsOf('tool_execution_update')
        .some(
          (event) =>
            toolCallId === undefined || event.toolCallId === toolCallId,
        ),
    'the running call to produce output',
  )
  return t.session.backgroundTasks(toolCallId)
}

test('a running bash call moves to the background: the call returns at once, a later turn works, and the exit is its own turn', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', { command: 'seq 1 20000; sleep 0.6; echo END' }),
      () => fauxText('Kept working while it runs.'),
      (request) => {
        expect(request.lastUserText).toStartWith(
          'Background command bg-1 finished with exit code 0.',
        )
        return fauxText('The command finished.')
      },
    ],
    extensions: [background()],
  })
  const running = t.run('count the lines')
  expect(await detachWhenRunning(t, 'faux-call-1-1')).toEqual(['bg-1'])
  await running
  // The call settled with the synthetic result: the id, the tail so far, no promised log path.
  const moved = t.model.calls[1]!.toolResults[0]!.output
  expect(moved).toContain(
    'Command was manually moved to the background with ID: bg-1.',
  )
  expect(moved).toContain(
    'You will be notified when it completes; do not poll the file or start a second copy.',
  )
  expect(moved).toContain('20000')
  expect(moved).not.toContain('Full output')
  expect(t.model.calls[0]!.tools).toContain('bash')
  // The turn continued while the command ran, and the history says it is still owed.
  expect(t.model.calls[1]!.toolResults[0]!.output).not.toContain('END')
  const history = await Bun.file(t.session.registry.results.history.path).text()
  expect(history).toContain('"backgroundTaskId":"bg-1"')
  expect(history).toContain('"backgroundedByUser":true')
  expect(history).toContain('"status":"completed"')
  // The exit is its own turn, carrying the output and the environment's spill file.
  await until(() => t.model.calls.length === 3, 'the exit turn')
  await until(() => !t.session.isRunning, 'the exit turn to settle')
  const delivery = t.model.calls[2]!.lastUserText
  expect(delivery).toContain('\n19000\n')
  expect(delivery).not.toContain('\n2\n')
  const full = /Full output: (\S+)/.exec(delivery)![1]!
  expect(full).toStartWith(t.session.registry.results.dir)
  const log = await Bun.file(full).text()
  expect(log).toStartWith('1\n')
  expect(log).toEndWith('END\n')
})

test('moving one call by its tool-call id leaves the other running; moving all takes both', async () => {
  const t = createTestVela({
    responses: [
      [
        fauxToolCall('bash', { command: 'echo FIRST; sleep 0.8' }),
        fauxToolCall('bash', { command: 'echo SECOND; sleep 0.8' }),
      ],
      fauxText('Moved one.'),
      (request) => fauxText(request.lastUserText),
    ],
    extensions: [background()],
  })
  const running = t.run('start two checks')
  await until(
    () => t.eventsOf('tool_execution_update').length === 2,
    'both calls to produce output',
  )
  expect(await t.session.backgroundTasks('faux-call-1-1')).toEqual(['bg-1'])
  // The other call is still in the foreground, so the turn has not settled yet.
  await Bun.sleep(50)
  expect(t.model.calls).toHaveLength(1)
  expect(await t.session.backgroundTasks()).toEqual(['bg-2'])
  await running
  await until(
    () =>
      t.session.messages.some(
        (message) =>
          typeof message.content === 'string' &&
          message.content.startsWith('Background command bg-1'),
      ) &&
      t.session.messages.some(
        (message) =>
          typeof message.content === 'string' &&
          message.content.startsWith('Background command bg-2'),
      ),
    'both exits to arrive',
  )
  const results = t.model.calls[1]!.toolResults
  expect(
    results.find((result) => result.toolCallId === 'faux-call-1-1')!.output,
  ).toContain('manually moved to the background with ID: bg-1')
  // The second one was moved by the call without an id; its output came along.
  expect(
    results.find((result) => result.toolCallId === 'faux-call-1-2')!.output,
  ).toContain('manually moved to the background with ID: bg-2')
  expect(
    results.find((result) => result.toolCallId === 'faux-call-1-2')!.output,
  ).toContain('SECOND')
})

test('an unknown tool-call id names the calls that are running', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', { command: 'echo STARTED; sleep 0.5' }),
      fauxText('Done.'),
    ],
    extensions: [background()],
  })
  const running = t.run('start the check')
  await until(
    () => t.eventsOf('tool_execution_update').length > 0,
    'the call to produce output',
  )
  // An unknown id is an error that names what is running, and changes nothing.
  expect(t.session.backgroundTasks('faux-call-9-9')).rejects.toThrow(
    'No running bash call with tool call ID faux-call-9-9. Running: faux-call-1-1',
  )
  expect(await t.session.backgroundTasks('faux-call-1-1')).toEqual(['bg-1'])
  await running
})

test('an aborted run keeps a moved job; closing the session stops it without delivering', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'echo STARTED; sleep 0.6; echo LATE > late.txt',
      }),
      fauxText('It keeps running.'),
    ],
    extensions: [background()],
    allowPendingResponses: true,
  })
  const running = t.run('start the check')
  expect(await detachWhenRunning(t)).toEqual(['bg-1'])
  await running
  // Esc: the run ends aborted, which no longer reaches a job the session owns.
  await t.session.abort()
  await until(() => existsSync(t.path('late.txt')), 'the job to reach its end')
  await until(
    () => JSON.stringify(t.session.messages).includes('LATE'),
    'the exit delivery',
  )
  // Closing the session stops what is left, and that exit is not delivered.
  const calls = t.model.calls.length
  await t.session.close()
  expect(calls).toBe(t.model.calls.length)
})

test('a moved job and a declared job answer background_output the same way and stop without delivering', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', { command: 'echo MOVED; sleep 0.6' }),
      fauxText('Moved it.'),
      fauxToolCall('bash', {
        command: 'echo DECLARED; sleep 30',
        run_in_background: true,
      }),
      fauxText('Declared it.'),
      fauxToolCall('background_output', { id: 'bg-1' }),
      fauxText('Read it.'),
      fauxToolCall('background_output', { id: 'bg-2' }),
      fauxText('Read the declared one.'),
      fauxToolCall('background_stop', { id: 'bg-1' }),
      fauxText('Stopped the moved one.'),
    ],
    extensions: [background()],
    allowPendingResponses: true,
  })
  const running = t.run('start the moved check')
  expect(await detachWhenRunning(t)).toEqual(['bg-1'])
  await running
  await t.run('start a declared check')
  // The declared job's first output needs the shell to start, which is real here.
  const jobs = t.session.registry.background!
  await until(
    () => jobs.snapshot('bg-2').output.includes('DECLARED'),
    'the declared job to print',
  )
  await t.run('read the moved job')
  const moved = t.model.calls.at(-1)!.toolResults[0]!.output
  expect(moved).toStartWith('bg-1 (')
  expect(moved).toContain('MOVED')
  await t.run('read the declared job')
  const declared = t.model.calls.at(-1)!.toolResults[0]!.output
  expect(declared).toStartWith('bg-2 (')
  expect(declared).toContain('DECLARED')
  await t.run('stop the moved job')
  const stopped = t.model.calls.at(-1)!.toolResults[0]!.output
  expect(stopped).toContain('bg-1 (stopped)')
  // A stop hands the tail to the caller, so it never starts a delivery turn of its own.
  await Bun.sleep(100)
  expect(
    t.model.calls.some((call) =>
      call.lastUserText.startsWith('Background command bg-1'),
    ),
  ).toBe(false)
})

test('moving your own `!` command records it as a background command, not a finished one', async () => {
  const t = createTestVela({
    responses: [(request) => fauxText(request.lastUserText)],
    extensions: [background()],
  })
  const entries = async () =>
    (await t.readData('sessions/default/transcript.jsonl'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  const updates: string[] = []
  const command = t.session.executeBash(
    'echo BASH_STARTED; sleep 0.5; echo BASH_DONE',
    { onUpdate: (output) => updates.push(output) },
  )
  await until(() => t.session.isBashRunning, 'the command to start')
  await until(() => updates.some((output) => output.includes('BASH_STARTED')))
  expect(await t.session.backgroundTasks()).toEqual(['bg-1'])
  const result = await command
  expect(result.backgroundTaskId).toBe('bg-1')
  expect(result.cancelled).toBe(false)
  expect(result.output).toContain('BASH_STARTED')
  // The session records the move once, and does not also claim a finished command.
  await until(async () =>
    (await entries()).some((entry) => entry.type === 'bash_execution'),
  )
  const saved = (await entries()).filter(
    (entry) => entry.type === 'bash_execution',
  )
  expect(saved).toEqual([
    expect.objectContaining({
      command: 'echo BASH_STARTED; sleep 0.5; echo BASH_DONE',
      backgroundTaskId: 'bg-1',
      cancelled: false,
    }),
  ])
  expect(saved[0]!.exitCode).toBeUndefined()
  expect(saved).not.toContain('BASH_DONE')
  // The model reads it as a background command whose result is still owed.
  await t.run('what happened?')
  expect(
    t.messages.some(
      (message) =>
        typeof message.content === 'string' &&
        message.content.includes(
          'Command moved to the background with ID bg-1; its result will be reported when it exits.',
        ),
    ),
  ).toBe(true)
  // Its exit is delivered like any other job.
  await until(
    () =>
      t.session.messages.some(
        (message) =>
          typeof message.content === 'string' &&
          message.content.startsWith('Background command bg-1 finished'),
      ),
    'the exit delivery',
  )
})

test('a start record that cannot be written leaves the command with its call, never an unowned job', async () => {
  const events: string[] = []
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'echo STARTED; sleep 0.4; echo LATE > late.txt',
      }),
      fauxText('The call kept it.'),
    ],
    extensions: [background()],
    session: {
      host: {
        deliver: () => {},
        background: async (event) => {
          events.push(event.type)
          if (event.type === 'started') throw new Error('cannot save start')
        },
      },
    },
    allowPendingResponses: true,
  })
  const running = t.run('start the check')
  const detaching = detachWhenRunning(t).then(
    () => 'moved',
    (error: Error) => error.message,
  )
  expect(await detaching).toBe('cannot save start')
  await running
  // The foreground call still owns the command and returns its own result.
  const result = t.model.calls[1]!.toolResults[0]!
  expect(result.output).toContain('STARTED')
  expect(result.output).not.toContain('moved to the background')
  // The command ran to its own end under the call, not under a job.
  expect(existsSync(t.path('late.txt'))).toBe(true)
  // The start record the host could not acknowledge is cleared, and nothing was delivered.
  expect(events).toEqual(['started', 'stopped'])
  expect(
    t.session.messages.some(
      (message) =>
        typeof message.content === 'string' &&
        message.content.startsWith('Background command'),
    ),
  ).toBe(false)
})

test('an interrupted run reaching a move whose start record failed cancels the command instead of orphaning it', async () => {
  const gate = Promise.withResolvers<void>()
  const events: string[] = []
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'echo STARTED; sleep 0.4; echo LATE > late.txt',
      }),
      fauxText('never reached'),
    ],
    extensions: [background()],
    session: {
      host: {
        deliver: () => {},
        background: async (event) => {
          events.push(event.type)
          if (event.type !== 'started') return
          // The write is in flight when the user presses Esc.
          await gate.promise
          throw new Error('cannot save start')
        },
      },
    },
    allowPendingResponses: true,
  })
  const running = t.run('start the check').catch(() => {})
  const detaching = detachWhenRunning(t).then(
    () => 'moved',
    (error: Error) => error.message,
  )
  await until(() => events.includes('started'), 'the start write to begin')
  await t.session.abort()
  gate.resolve()
  expect(await detaching).toBe('cannot save start')
  await running
  // The old abort is not replayed to a removed listener, so the rollback cancels it itself.
  await Bun.sleep(300)
  expect(t.exists('late.txt')).toBe(false)
  expect(events).toEqual(['started', 'stopped'])
  expect(
    t.session.messages.some(
      (message) =>
        typeof message.content === 'string' &&
        message.content.startsWith('Background command'),
    ),
  ).toBe(false)
})

test('a move whose start record succeeds keeps the job even when the run was interrupted while it was written', async () => {
  const gate = Promise.withResolvers<void>()
  const delivered: string[] = []
  const writes: string[] = []
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'echo STARTED; sleep 0.4; echo LATE > late.txt',
      }),
      fauxText('never reached'),
    ],
    extensions: [background()],
    session: {
      host: {
        deliver: () => {},
        background: async (event) => {
          writes.push(event.type)
          if (event.type === 'started') await gate.promise
          if (event.type === 'result') delivered.push(event.text)
        },
      },
    },
    allowPendingResponses: true,
  })
  const running = t.run('start the check').catch(() => {})
  const detaching = detachWhenRunning(t)
  await until(() => writes.includes('started'), 'the start write to begin')
  // Abort waits for the running call, and that call waits for this write: release it, not before.
  const aborting = t.session.abort()
  gate.resolve()
  expect(await detaching).toEqual(['bg-1'])
  await aborting
  await running
  // Claimed before the abort: the job keeps running and its exit is delivered.
  await until(() => delivered.length === 1, 'the exit delivery')
  expect(delivered[0]).toStartWith(
    'Background command bg-1 finished with exit code 0.',
  )
  expect(existsSync(t.path('late.txt'))).toBe(true)
})

test('an interrupted run keeps a declared job too, and its exit still arrives', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'sleep 0.5; echo LATE > late.txt',
        run_in_background: true,
      }),
      fauxText('started'),
      fauxText('The command finished.'),
    ],
    extensions: [background()],
    allowPendingResponses: true,
  })
  await t.run('start the check')
  await until(() => t.session.hasWork, 'the job to be tracked')
  await t.session.abort()
  // Esc no longer reaches a job the session owns; only close and shutdown stop it.
  await until(() => existsSync(t.path('late.txt')), 'the job to reach its end')
  await until(
    () => t.model.calls.length === 3,
    'the exit turn the abort did not cancel',
  )
  expect(t.model.calls[2]!.lastUserText).toStartWith(
    'Background command bg-1 finished with exit code 0.',
  )
})

test('two overlapping requests never move the same call twice', async () => {
  const t = createTestVela({
    responses: [
      [
        fauxToolCall('bash', { command: 'echo FIRST; sleep 0.5' }),
        fauxToolCall('bash', { command: 'echo SECOND; sleep 0.5' }),
      ],
      (request) => fauxText(request.lastUserText),
    ],
    extensions: [background()],
    allowPendingResponses: true,
  })
  const running = t.run('start two checks')
  await until(
    () => t.eventsOf('tool_execution_update').length === 2,
    'both calls to produce output',
  )
  // RPC dispatch allows overlapping requests: the first takes everything, and while it is
  // awaiting the first start record, a second one targets the call it has not reached yet.
  const all = t.session.backgroundTasks()
  const targeted = t.session.backgroundTasks('faux-call-1-2')
  const results = await Promise.allSettled([targeted, all])
  const ids = results.flatMap((result) =>
    result.status === 'fulfilled' ? result.value : [],
  )
  // Two processes, so two jobs: a second claim on the same call would make a third id.
  expect(ids.slice().sort()).toEqual(['bg-1', 'bg-2'])
  expect(new Set(ids).size).toBe(2)
  await running
  await until(
    () =>
      ['bg-1', 'bg-2'].every((id) =>
        t.session.messages.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.startsWith(`Background command ${id}`),
        ),
      ),
    'one exit per job',
  )
  // Each job delivered once, so no process was handed over twice.
  expect(
    t.session.messages.filter(
      (message) =>
        typeof message.content === 'string' &&
        message.content.startsWith('Background command bg-1'),
    ),
  ).toHaveLength(1)
  expect(
    t.session.messages.filter(
      (message) =>
        typeof message.content === 'string' &&
        message.content.startsWith('Background command bg-2'),
    ),
  ).toHaveLength(1)
})

test('a `!!` command stays in the foreground, so its output never reaches the model', async () => {
  const t = createTestVela({
    responses: [(request) => fauxText(request.lastUserText)],
    extensions: [background()],
  })
  const updates: string[] = []
  const command = t.session.executeBash('echo SECRET; sleep 0.3', {
    excludeFromContext: true,
    onUpdate: (output) => updates.push(output),
  })
  await until(() => t.session.isBashRunning, 'the command to start')
  await until(() => updates.some((output) => output.includes('SECRET')))
  // Moving everything skips it: a job's exit is delivered to the model, which `!!` promised not to do.
  expect(await t.session.backgroundTasks()).toEqual([])
  expect(await command).toMatchObject({ cancelled: false, exitCode: 0 })
  await t.run('hello')
  // No job was created, so no exit turn; the exclusion keeps the output out of the context.
  expect(t.model.calls).toHaveLength(1)
  expect(JSON.stringify(t.messages)).not.toContain('SECRET')
})

test('moving everything leaves a `!!` behind and takes the model call beside it', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', { command: 'echo CALL; sleep 0.4' }),
      fauxText('moved'),
      fauxText('finished'),
    ],
    extensions: [background()],
    allowPendingResponses: true,
  })
  const updates: string[] = []
  const own = t.session.executeBash('echo SECRET; sleep 0.4', {
    excludeFromContext: true,
    onUpdate: (output) => updates.push(output),
  })
  await until(() => updates.some((output) => output.includes('SECRET')))
  const running = t.run('start the check')
  await until(
    () => t.eventsOf('tool_execution_update').length > 0,
    'the tool call to produce output',
  )
  // Only the model-issued call moves; the user's excluded command keeps its own result.
  expect(await t.session.backgroundTasks()).toEqual(['bg-1'])
  await running
  expect(await own).toMatchObject({ cancelled: false, exitCode: 0 })
  await until(
    () => JSON.stringify(t.messages).includes('Background command bg-1'),
    'the moved job exit',
  )
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain(
    'Command was manually moved to the background with ID: bg-1.',
  )
  expect(JSON.stringify(t.messages)).not.toContain('SECRET')
})

test('cancelling a `!` command during a slow `session_start` returns at once', async () => {
  const gate = Promise.withResolvers<void>()
  const t = createTestVela({
    responses: [(request) => fauxText(request.lastUserText)],
    extensions: [
      background(),
      function slowStart(api) {
        api.on('session_start', () => gate.promise)
      },
    ],
    allowPendingResponses: true,
  })
  const command = t.session.executeBash('echo LATE')
  await until(() => t.session.isBashRunning, 'the command to reach its startup')
  const aborting = t.session.abortBash()
  // The hook is still suspended; cancelling must not wait for it.
  const result = await Promise.race([
    command,
    Bun.sleep(1000).then(() => 'hung' as const),
  ])
  expect(result).toMatchObject({ cancelled: true, exitCode: undefined })
  expect(t.session.isBashRunning).toBe(false)
  expect(t.exists('LATE')).toBe(false)
  gate.resolve()
  await aborting
})
