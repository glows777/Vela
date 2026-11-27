import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalExecutionEnv } from '../../../../src/driver/execution/local.ts'
import type { ExecutionEnv } from '../../../../src/driver/execution/types.ts'
import { background } from '../../../../src/driver/extensions/background/index.ts'
import { BackgroundJobs } from '../../../../src/driver/extensions/background/jobs.ts'
import { SessionWork } from '../../../../src/driver/session/work.ts'
import { backgroundBash } from '../../../../src/driver/tools/environment-bash.ts'
import {
  OUTPUT_MAX_BYTES as MAX_BYTES,
  OUTPUT_MAX_LINES as MAX_LINES,
  OutputTail,
} from '../../../../src/driver/tools/output-tail.ts'
import type { VelaSession } from '../../../../src/driver/vela-session.ts'
import { silentLogger } from '../../../../src/shared/logger.ts'
import { fauxText, fauxToolCall } from '../../../../src/testing/core/faux.ts'
import {
  cleanupTestVelas,
  createTestVela,
} from '../../../../src/testing/core/test-vela.ts'

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

/** A session stub for the job table: cwd, message delivery queue, and the work it tracks. */
function sessionStub(cwd: string, delivered: string[]) {
  return {
    id: 'stub',
    cwd,
    backgroundWork: new SessionWork(false),
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
    spillDir: join(root, 'results'),
  }
  await backgroundBash('echo hi', undefined, root, undefined, context, jobs)
  expect(argvs).toEqual([['/opt/bash', '-c', 'echo hi']])

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
    { execution: env, spillDir: join(root, 'results') },
    jobs,
  )
  expect(result.text).toStartWith('READY_AT_ADMISSION\n\n')
  expect(result.text).toContain('Command running in background with ID: bg-1.')
  expect(result.execution.backgroundTaskId).toBe('bg-1')
  await until(() => delivered.length === 1, 'the exit delivery')
})

test('a background command runs to completion and its delivery carries the exit code and tail', async () => {
  const delivered: string[] = []
  const session = sessionStub(directory(), delivered)
  const jobs = new BackgroundJobs(session, silentLogger)
  const id = await startJob(
    jobs,
    createLocalExecutionEnv({ cwd: session.cwd }),
    'echo READY; exit 3',
  )
  expect(id).toBe('bg-1')
  await until(() => delivered.length === 1, 'the exit delivery')
  expect(delivered[0]!).toContain(
    'Background command bg-1 finished with exit code 3.',
  )
  expect(delivered[0]!).toContain('Command: echo READY; exit 3')
  expect(delivered[0]!).toContain('READY')
  // Delivered: the job and its tail are gone, so asking again explains it ended.
  expect(() => jobs.snapshot('bg-1')).toThrow(
    'Unknown background command bg-1.',
  )
})

test('stopping a job ends its process group and returns the tail without another delivery', async () => {
  const delivered: string[] = []
  const session = sessionStub(directory(), delivered)
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
  expect(delivered).toEqual([])
})

test('stopping gives the process tree a graceful SIGTERM phase before SIGKILL', async () => {
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
  expect(existsSync(join(root, 'shutdown-complete'))).toBe(true)
  expect(Date.now() - t0).toBeLessThan(1000)
})

test('a descendant that ignores SIGTERM is killed after the shell exits', async () => {
  const root = directory()
  const delivered: string[] = []
  const session = sessionStub(root, delivered)
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
  expect(delivered).toEqual([])
})

test('an unknown id says it may have ended with a restart or session close', () => {
  const jobs = new BackgroundJobs(sessionStub(directory(), []), silentLogger)
  expect(() => jobs.snapshot('bg-9')).toThrow(
    'Unknown background command bg-9. It may have finished and its result was delivered (or returned by background_stop), or it ended with a restart or session close.',
  )
})

test('stopAll ends every running job without starting a delivery run', async () => {
  const delivered: string[] = []
  const session = sessionStub(directory(), delivered)
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
