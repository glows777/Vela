import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalExecutionEnv } from '../../../src/execution/local.ts'
import type { ExecutionEnv } from '../../../src/execution/types.ts'
import { background } from '../../../src/extensions/background/index.ts'
import {
  BackgroundJobs,
  OutputTail,
} from '../../../src/extensions/background/jobs.ts'
import { silentLogger } from '../../../src/logger.ts'
import type { SessionOptions } from '../../../src/session/options.ts'
import { ToolResultStore } from '../../../src/session/tool-results.ts'
import { fauxText, fauxToolCall } from '../../../src/testing/faux.ts'
import {
  cleanupTestVelas,
  createTestVela,
} from '../../../src/testing/test-vela.ts'
import { backgroundBash } from '../../../src/tools/environment-bash.ts'
import {
  OUTPUT_MAX_BYTES as MAX_BYTES,
  OUTPUT_MAX_LINES as MAX_LINES,
} from '../../../src/tools/output-tail.ts'
import type { VelaSession } from '../../../src/vela-session.ts'

afterEach(cleanupTestVelas)

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

async function until(check: () => boolean, what = 'condition') {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

/** A session stub for the job table: cwd, its host's queue, and the work it tracks. */
function sessionStub(
  cwd: string,
  delivered: string[],
  deliver?: (text: string) => void,
  background?: NonNullable<SessionOptions['host']>['background'],
) {
  return {
    id: 'stub',
    cwd,
    ...(deliver || background
      ? { host: { deliver: deliver ?? (() => {}), background } }
      : {}),
    trackWork: () => {},
    sendMessage: async (message: { content: string }) => {
      delivered.push(String(message.content))
    },
  } as unknown as VelaSession
}

function directory() {
  const path = mkdtempSync(join(tmpdir(), 'vela-background-'))
  roots.push(path)
  return path
}

/** Starts a command the way the bash tool does: the job owns its signal and output sink. */
async function startJob(
  jobs: BackgroundJobs,
  env: ExecutionEnv,
  command: string,
): Promise<string> {
  const { id } = await jobs.adopt({
    command,
    start: ({ onOutput, signal }) => env.exec(command, { onOutput }, signal),
  })
  return id
}

test('the output tail keeps the last 2000 lines and 50KB, and says when it cut', () => {
  const tail = new OutputTail()
  for (let line = 1; line <= MAX_LINES + 10; line++)
    tail.append(`line ${line}\n`)
  const read = tail.read()
  expect(read.truncated).toBe(true)
  const lines = read.text.trimEnd().split('\n')
  expect(lines).toHaveLength(MAX_LINES)
  expect(lines[0]).toBe('line 11')
  expect(lines.at(-1)).toBe(`line ${MAX_LINES + 10}`)

  const bytes = new OutputTail()
  bytes.append('x'.repeat(MAX_BYTES + 100))
  const cut = bytes.read()
  expect(cut.truncated).toBe(true)
  expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(MAX_BYTES)
})

test('a single huge line keeps the tail of its cut end instead of reporting no output', () => {
  const tail = new OutputTail()
  const huge = 'x'.repeat(MAX_BYTES + 100)
  tail.append(`${huge}\n`)
  const read = tail.read()
  expect(read.truncated).toBe(true)
  expect(read.text).toContain('x')
  expect(Buffer.byteLength(read.text)).toBeLessThanOrEqual(MAX_BYTES)
})

test('background({ shellPath }) runs a local job with that shell, and leaves other environments alone', async () => {
  const root = directory()
  const argvs: (string | readonly string[])[] = []
  const env = createLocalExecutionEnv({ cwd: root })
  env.exec = async (command) => {
    argvs.push(command)
    return { ok: true, value: { exitCode: 0 } }
  }
  const jobs = new BackgroundJobs(
    sessionStub(root, []),
    silentLogger,
    '/opt/bash',
  )
  const context = {
    execution: env,
    results: new ToolResultStore(join(root, 'results')),
  }
  await backgroundBash('echo hi', undefined, root, undefined, context, jobs)
  expect(argvs).toEqual([['/opt/bash', '-lc', 'echo hi']])

  // An environment that is not the local adapter runs the command itself.
  const remote = { ...env, id: 'test:remote' } as typeof env
  remote.exec = async (command) => {
    argvs.push(command)
    return { ok: true, value: { exitCode: 0 } }
  }
  await backgroundBash(
    'echo hi',
    undefined,
    root,
    undefined,
    { ...context, execution: remote },
    jobs,
  )
  expect(argvs[1]).toBe('echo hi')
})

test('cancelling the bash call while its job is being recorded starts nothing', async () => {
  const root = directory()
  const gate = Promise.withResolvers<void>()
  const controller = new AbortController()
  const kinds: string[] = []
  const session = sessionStub(root, [], undefined, async (event) => {
    kinds.push(event.type)
    if (event.type === 'started') await gate.promise
  })
  const jobs = new BackgroundJobs(session, silentLogger)
  const starting = backgroundBash(
    'touch marker; echo RAN',
    undefined,
    root,
    undefined,
    {
      execution: createLocalExecutionEnv({ cwd: root }),
      results: new ToolResultStore(join(root, 'results')),
      signal: controller.signal,
    },
    jobs,
  ).then(
    () => 'started',
    (error: Error) => error.name,
  )
  // The host has not finished recording the job; this is where a cancelled call still hung on.
  await until(() => kinds.includes('started'))
  controller.abort()
  gate.resolve()
  expect(await starting).toBe('AbortError')
  expect(existsSync(join(root, 'marker'))).toBe(false)
  await Bun.sleep(50)
  expect(kinds).toEqual(['started', 'stopped'])
})

test('a running job keeps its own signal after the call that started it is cancelled', async () => {
  const root = directory()
  const gate = Promise.withResolvers<void>()
  const controller = new AbortController()
  const results: string[] = []
  const session = sessionStub(root, [], undefined, async (event) => {
    if (event.type === 'started') await gate.promise
    if (event.type === 'result') results.push(event.text)
  })
  const jobs = new BackgroundJobs(session, silentLogger)
  const command = 'sleep 0.2; echo RAN > marker'
  const starting = jobs.adopt({
    command,
    signal: controller.signal,
    start: ({ onOutput, signal }) =>
      createLocalExecutionEnv({ cwd: root }).exec(
        command,
        { onOutput },
        signal,
      ),
  })
  gate.resolve()
  const { id } = await starting
  // The call is over and cancelled; the job it admitted still runs to its own end.
  controller.abort()
  await until(() => results.length === 1, 'the exit delivery')
  expect(results[0]).toContain(
    `Background command ${id} finished with exit code 0.`,
  )
  expect(existsSync(join(root, 'marker'))).toBe(true)
})

test('an adapter that only implements the published contract still delivers its full log', async () => {
  const root = directory()
  const local = createLocalExecutionEnv({ cwd: root })
  let spilled = ''
  // A host adapter written against today's `ExecutionEnv`: it forwards `onOutput` and decides its
  // own spill file, which it can only name once the command has finished. It knows nothing about
  // how a background command reports that file.
  const adapter: ExecutionEnv = {
    ...local,
    id: 'test:published',
    exec: async (command, options, signal) => {
      let collected = ''
      const result = await local.exec(
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
      const spill =
        Buffer.byteLength(collected) > (options?.spill?.afterBytes ?? Infinity)
      if (spill) {
        const created = await local.createTempFile(
          { prefix: 'adapter-', suffix: '.log' },
          signal,
        )
        if (created.ok) {
          spilled = created.value
          await local.writeFile(spilled, collected, signal)
        }
      }
      return result.ok
        ? {
            ok: true,
            value: {
              ...result.value,
              ...(spilled ? { spillPath: spilled } : {}),
            },
          }
        : result
    },
  }
  const results: string[] = []
  const session = sessionStub(root, [], undefined, (event) => {
    if (event.type === 'result') results.push(event.text)
  })
  const jobs = new BackgroundJobs(session, silentLogger)
  const started = await backgroundBash(
    'seq 1 20000',
    undefined,
    root,
    undefined,
    { execution: adapter, results: new ToolResultStore(join(root, 'results')) },
    jobs,
  )
  // The start result names no file: only the exit knows where the adapter spilled the output.
  expect(started.text).not.toContain('Full output')
  await until(() => results.length === 1, 'the exit delivery')
  expect(results[0]).toContain(
    'Background command bg-1 finished with exit code 0.',
  )
  expect(spilled).not.toBe('')
  expect(results[0]).toContain(`Full output: ${spilled}`)
  // The adapter's own file holds the whole log, so the model can page it.
  expect((await Bun.file(spilled).text()).trimEnd().split('\n')).toHaveLength(
    20000,
  )
})

test('a background command with no output reports none, and names no file', async () => {
  const root = directory()
  const results: string[] = []
  const session = sessionStub(root, [], undefined, (event) => {
    if (event.type === 'result') results.push(event.text)
  })
  const jobs = new BackgroundJobs(session, silentLogger)
  const started = await backgroundBash(
    'true',
    undefined,
    root,
    undefined,
    {
      execution: createLocalExecutionEnv({ cwd: root }),
      results: new ToolResultStore(join(root, 'results')),
    },
    jobs,
  )
  expect(started.text).toStartWith(
    'Command running in background with ID: bg-1.',
  )
  await until(() => results.length === 1, 'the exit delivery')
  expect(results[0]).toContain('Output:\n(no output)')
  expect(results[0]).not.toContain('Full output')
})

test('the start result carries the tail a command already produced', async () => {
  const root = directory()
  const env = createLocalExecutionEnv({ cwd: root })
  // A legal environment can write output before exec settles; the call must report that tail.
  env.exec = async (_command, options) => {
    options?.onOutput?.('READY_AT_ADMISSION\n', undefined, { stream: 'stdout' })
    return { ok: true, value: { exitCode: 0 } }
  }
  const delivered: string[] = []
  const jobs = new BackgroundJobs(sessionStub(root, delivered), silentLogger)
  const result = await backgroundBash(
    'start the server',
    undefined,
    root,
    undefined,
    { execution: env, results: new ToolResultStore(join(root, 'results')) },
    jobs,
  )
  expect(result.text).toStartWith('READY_AT_ADMISSION\n\n')
  expect(result.text).toContain('Command running in background with ID: bg-1.')
  expect(result.execution.backgroundTaskId).toBe('bg-1')
  await until(() => delivered.length === 1, 'the exit delivery')
})

test('a background command runs to completion and its delivery carries the exit code and tail', async () => {
  const delivered: string[] = []
  const reports: string[] = []
  const session = sessionStub(directory(), delivered, (text) =>
    reports.push(text),
  )
  const jobs = new BackgroundJobs(session, silentLogger)
  const id = await startJob(
    jobs,
    createLocalExecutionEnv({ cwd: session.cwd }),
    'echo READY; exit 3',
  )
  expect(id).toBe('bg-1')
  await until(() => reports.length === 1, 'the exit delivery')
  expect(reports[0]!).toContain(
    'Background command bg-1 finished with exit code 3.',
  )
  expect(reports[0]!).toContain('Command: echo READY; exit 3')
  expect(reports[0]!).toContain('READY')
  // Delivered: the job and its tail are gone, so asking again explains it ended.
  expect(() => jobs.snapshot('bg-1')).toThrow(
    'Unknown background command bg-1.',
  )
})

test('stopping a job ends its process group and returns the tail without another delivery', async () => {
  const reports: string[] = []
  const session = sessionStub(directory(), [], (text) => reports.push(text))
  const jobs = new BackgroundJobs(session, silentLogger)
  await startJob(
    jobs,
    createLocalExecutionEnv({ cwd: session.cwd }),
    'echo STARTED; sleep 30; echo NEVER',
  )
  await until(
    () => jobs.snapshot('bg-1').output.includes('STARTED'),
    'the first output',
  )
  const stopped = await jobs.stop('bg-1')
  expect(stopped.state).toBe('exited')
  expect(stopped.stopped).toBe(true)
  expect(stopped.output).toContain('STARTED')
  expect(stopped.output).not.toContain('NEVER')
  // The tool result carries the tail, so a stop must not also start a delivery turn.
  await Bun.sleep(50)
  expect(reports).toEqual([])
})

test('stopping aborts the process tree without a graceful SIGTERM phase', async () => {
  const root = directory()
  await Bun.write(
    join(root, 'graceful.cjs'),
    `process.on('SIGTERM', () => {
  setTimeout(() => {
    require('node:fs').writeFileSync('shutdown-complete', 'yes')
    process.exit(0)
  }, 100)
})
console.log('READY')
setInterval(() => {}, 1000)
`,
  )
  const session = sessionStub(root, [])
  const jobs = new BackgroundJobs(session, silentLogger)
  await startJob(
    jobs,
    createLocalExecutionEnv({ cwd: session.cwd }),
    'node graceful.cjs & wait',
  )
  await until(
    () => jobs.snapshot('bg-1').output.includes('READY'),
    'the descendant to register its SIGTERM handler',
  )
  const t0 = Date.now()
  const stopped = await jobs.stop('bg-1')
  expect(stopped.stopped).toBe(true)
  expect(existsSync(join(root, 'shutdown-complete'))).toBe(false)
  expect(Date.now() - t0).toBeLessThan(1000)
})

test('a descendant that ignores SIGTERM is killed after the shell exits', async () => {
  const root = directory()
  const reports: string[] = []
  const session = sessionStub(root, [], (text) => reports.push(text))
  const jobs = new BackgroundJobs(session, silentLogger)
  // The shell exits on SIGTERM; its child ignores SIGTERM and would outlive the stop.
  await startJob(
    jobs,
    createLocalExecutionEnv({ cwd: session.cwd }),
    `bash -c 'trap "" TERM; echo $$ > child.pid; echo READY; sleep 30' & wait`,
  )
  await until(
    () => jobs.snapshot('bg-1').output.includes('READY'),
    'the first output',
  )
  const child = Number((await Bun.file(join(root, 'child.pid')).text()).trim())
  expect(() => process.kill(child, 0)).not.toThrow()
  await jobs.stop('bg-1')
  await Bun.sleep(200)
  expect(() => process.kill(child, 0)).toThrow()
  // A stop never delivers: the tool result carries the tail.
  expect(reports).toEqual([])
})

test('an unknown id says it may have ended with a restart or session close', () => {
  const jobs = new BackgroundJobs(sessionStub(directory(), []), silentLogger)
  expect(() => jobs.snapshot('bg-9')).toThrow(
    'Unknown background command bg-9. It may have finished and its result was delivered (or returned by background_stop), or it ended with a restart or session close.',
  )
})

test('stopAll ends every running job without starting a delivery run', async () => {
  const delivered: string[] = []
  const reports: string[] = []
  const session = sessionStub(directory(), delivered, (text) =>
    reports.push(text),
  )
  const jobs = new BackgroundJobs(session, silentLogger)
  await startJob(
    jobs,
    createLocalExecutionEnv({ cwd: session.cwd }),
    'sleep 30',
  )
  await startJob(
    jobs,
    createLocalExecutionEnv({ cwd: session.cwd }),
    'sleep 30',
  )
  await jobs.stopAll()
  for (const id of ['bg-1', 'bg-2'])
    expect(() => jobs.snapshot(id)).toThrow(`Unknown background command ${id}.`)
  await Bun.sleep(50)
  expect(reports).toEqual([])
  expect(delivered).toEqual([])
})

test('outside channels the exit is a custom message that starts a turn', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'sleep 0.2; echo READY',
        run_in_background: true,
      }),
      fauxText('started'),
      (request) => {
        expect(request.lastUserText).toContain(
          'Background command bg-1 finished with exit code 0.',
        )
        expect(request.lastUserText).toContain('READY')
        return fauxText('the command finished')
      },
    ],
    extensions: [background()],
    session: { tools: ['bash', 'background_output', 'background_stop'] },
  })
  await t.run('start the check')
  await until(() => t.model.calls.length === 3, 'the delivery turn')
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain(
    'Command running in background with ID: bg-1.',
  )
  expect(t.model.calls[2]!.toolResults).toEqual([])
  await until(() => !t.session.isRunning, 'the delivery run to settle')
  expect(
    t.session.messages.some(
      (message) =>
        typeof message.content === 'string' &&
        message.content.startsWith('Background command bg-1 finished'),
    ),
  ).toBe(true)
})

test('Stop aborts the run and kills its background command', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        // A killed process never writes the marker; a surviving one does.
        command: 'sleep 0.3; echo late > late.txt',
        run_in_background: true,
      }),
      () => {
        void t.session.abort(new DOMException('stopped', 'AbortError'))
        return fauxText('never')
      },
    ],
    extensions: [background()],
    session: { tools: ['bash', 'background_stop'] },
    allowPendingResponses: true,
  })
  await t.run('start it').catch(() => {})
  await Bun.sleep(600)
  expect(t.exists('late.txt')).toBe(false)
})

test('a host records a unique job token before execution and receives the same token with its result', async () => {
  type Event = Parameters<
    NonNullable<NonNullable<SessionOptions['host']>['background']>
  >[0]
  const events: Event[] = []
  const gate = Promise.withResolvers<void>()
  const root = directory()
  const session = sessionStub(
    root,
    [],
    () => {
      throw new Error('legacy delivery should not run')
    },
    async (event) => {
      events.push(event)
      if (event.type === 'started') await gate.promise
    },
  )
  const jobs = new BackgroundJobs(session, silentLogger)
  const starting = startJob(
    jobs,
    createLocalExecutionEnv({ cwd: root }),
    'echo started > marker',
  )
  await until(() => events.length === 1)
  expect(existsSync(join(root, 'marker'))).toBe(false)
  expect(events[0]).toMatchObject({
    type: 'started',
    id: 'bg-1',
    commandHead: 'echo started > marker',
  })
  gate.resolve()
  await starting
  await until(() => events.some((event) => event.type === 'result'))
  const token = events[0]!.token
  expect(token).toMatch(/^[0-9a-f-]{36}$/)
  expect(events.find((event) => event.type === 'result')).toMatchObject({
    token,
  })
  const next = new BackgroundJobs(session, silentLogger)
  await startJob(next, createLocalExecutionEnv({ cwd: root }), 'true')
  await until(
    () => events.filter((event) => event.type === 'result').length === 2,
  )
  const starts = events.filter((event) => event.type === 'started')
  expect(starts[1]!.id).toBe('bg-1')
  expect(starts[1]!.token).not.toBe(token)
})

test('failed start persistence rejects without executing or promising a background result', async () => {
  const root = directory()
  const kinds: string[] = []
  const session = sessionStub(root, [], undefined, (event) => {
    kinds.push(event.type)
    if (event.type === 'started') throw new Error('cannot save start')
  })
  const jobs = new BackgroundJobs(session, silentLogger)
  await expect(
    startJob(jobs, createLocalExecutionEnv({ cwd: root }), 'touch marker'),
  ).rejects.toThrow('cannot save start')
  expect(existsSync(join(root, 'marker'))).toBe(false)
  expect(kinds).toEqual(['started', 'stopped'])
})

test.each(['signal', 'stopAll'] as const)(
  '%s during start persistence never launches a command',
  async (mode) => {
    const root = directory()
    const gate = Promise.withResolvers<void>()
    let saving = false
    const stopped: unknown[] = []
    const delivered: string[] = []
    const session = sessionStub(root, delivered, undefined, async (event) => {
      if (event.type === 'started') {
        saving = true
        await gate.promise
      }
      if (event.type === 'stopped') stopped.push(event)
    })
    const controller = new AbortController()
    const jobs = new BackgroundJobs(session, silentLogger)
    const starting = jobs
      .adopt({
        command: 'touch marker',
        signal: controller.signal,
        start: ({ onOutput, signal }) =>
          createLocalExecutionEnv({ cwd: root }).exec(
            'touch marker',
            { onOutput },
            signal,
          ),
      })
      .then(
        () => 'started',
        () => 'cancelled',
      )
    await until(() => saving)
    const stopping =
      mode === 'stopAll' ? jobs.stopAll() : Promise.resolve(controller.abort())
    gate.resolve()
    expect(await starting).toBe('cancelled')
    await stopping
    expect(existsSync(join(root, 'marker'))).toBe(false)
    expect(stopped.length).toBeGreaterThan(0)
    // A cancelled admission promised nothing, so it does not announce an exit either.
    await Bun.sleep(50)
    expect(delivered).toEqual([])
  },
)

test('stopAll clears host-owned outstanding results without waiting for the queued result turn', async () => {
  const root = directory()
  const result = Promise.withResolvers<void>()
  let queued = false
  let cleared = false
  const session = sessionStub(root, [], undefined, (event) => {
    if (event.type === 'result') {
      queued = true
      return result.promise
    }
    if (event.type === 'stopped' && !event.token) cleared = true
  })
  const jobs = new BackgroundJobs(session, silentLogger)
  await startJob(jobs, createLocalExecutionEnv({ cwd: root }), 'true')
  await until(() => queued)
  await jobs.stopAll()
  expect(cleared).toBe(true)
  result.resolve()
})

test('bash does not promise a background result when the host refuses the durable start record', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'touch must-not-run',
        run_in_background: true,
      }),
      (request) => {
        expect(request.toolResults[0]!.output).toContain(
          'host could not save start',
        )
        expect(request.toolResults[0]!.output).not.toContain(
          'Command running in background with ID:',
        )
        return fauxText('start failed')
      },
    ],
    extensions: [background()],
    session: {
      tools: ['bash', 'background_stop'],
      host: {
        deliver() {},
        background(event) {
          if (event.type === 'started')
            throw new Error('host could not save start')
        },
      },
    },
  })
  await t.run('start the command')
  expect(t.exists('must-not-run')).toBe(false)
})

test('Stop captures host cancellation before slow termination and does not clear jobs started by a later run', async () => {
  const root = directory()
  const tokens = new Set<string>()
  let writing = Promise.resolve()
  const session = sessionStub(root, [], undefined, (event) => {
    // Like the channel directory, host updates enter a serialized write queue
    // synchronously and resolve their current state when that write executes.
    writing = writing.then(() => {
      if (event.type === 'started') tokens.add(event.token)
      if (event.type === 'stopped') {
        if (event.token) tokens.delete(event.token)
        else tokens.clear()
      }
    })
    return writing
  })
  const old = Promise.withResolvers<void>()
  const next = Promise.withResolvers<void>()
  let executions = 0
  const start = () => {
    const run = ++executions === 1 ? old.promise : next.promise
    return run.then(() => ({ ok: true, value: { exitCode: 0 } }) as const)
  }
  const jobs = new BackgroundJobs(session, silentLogger)
  try {
    await jobs.adopt({ command: 'old', start })
    const stopping = jobs.stopAll()
    await jobs.adopt({ command: 'new', start })
    expect(jobs.snapshot('bg-2').state).toBe('running')
    expect(tokens.size).toBe(1)
    const retained = [...tokens][0]!
    old.resolve()
    await stopping
    expect(tokens).toEqual(new Set([retained]))
    expect(jobs.snapshot('bg-2').state).toBe('running')
  } finally {
    old.resolve()
    next.resolve()
    await jobs.stopAll()
  }
})
