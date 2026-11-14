import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BACKGROUND_DELIVERY,
  type BackgroundDelivery,
  type BackgroundResult,
} from '../../../src/extensions/background/host.ts'
import { background } from '../../../src/extensions/background/index.ts'
import {
  BackgroundJobs,
  MAX_BYTES,
  MAX_LINES,
  OutputTail,
} from '../../../src/extensions/background/jobs.ts'
import { silentLogger } from '../../../src/logger.ts'
import { fauxText, fauxToolCall } from '../../../src/testing/faux.ts'
import {
  cleanupTestVelas,
  createTestVela,
} from '../../../src/testing/test-vela.ts'
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

/** Bind a delivery like the channels package does, without its session plumbing. */
function bind(session: VelaSession, delivery: BackgroundDelivery): void {
  ;(session as unknown as Record<symbol, BackgroundDelivery>)[
    BACKGROUND_DELIVERY
  ] = delivery
}

/** A session stub for the job table: cwd plus the two things a delivery uses. */
function sessionStub(cwd: string, delivered: string[]) {
  return {
    id: 'stub',
    cwd,
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

test('a background command runs to completion and its delivery carries the exit code and tail', async () => {
  const delivered: string[] = []
  const reports: BackgroundResult[] = []
  const session = sessionStub(directory(), delivered)
  bind(session, (_session, result) => {
    reports.push(result)
  })
  const jobs = new BackgroundJobs(session, () => 'bash', silentLogger)
  const { id } = jobs.start('echo READY; exit 3')
  expect(id).toBe('bg-1')
  await until(() => reports.length === 1, 'the exit delivery')
  expect(reports[0]!.id).toBe('bg-1')
  expect(reports[0]!.text).toContain(
    'Background command bg-1 finished with exit code 3.',
  )
  expect(reports[0]!.text).toContain('Command: echo READY; exit 3')
  expect(reports[0]!.text).toContain('READY')
  expect(jobs.snapshot('bg-1')).toMatchObject({ state: 'exited', exitCode: 3 })
})

test('stopping a job ends its process group and returns the tail without another delivery', async () => {
  const reports: BackgroundResult[] = []
  const session = sessionStub(directory(), [])
  bind(session, (_session, result) => {
    reports.push(result)
  })
  const jobs = new BackgroundJobs(session, () => 'bash', silentLogger)
  jobs.start('echo STARTED; sleep 30; echo NEVER')
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

test('a descendant that ignores SIGTERM is killed after the shell exits', async () => {
  const root = directory()
  const reports: BackgroundResult[] = []
  const session = sessionStub(root, [])
  bind(session, (_session, result) => {
    reports.push(result)
  })
  const jobs = new BackgroundJobs(session, () => 'bash', silentLogger)
  // The shell exits on SIGTERM; its child ignores SIGTERM and would outlive the stop.
  jobs.start(
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
  const jobs = new BackgroundJobs(
    sessionStub(directory(), []),
    () => 'bash',
    silentLogger,
  )
  expect(() => jobs.snapshot('bg-9')).toThrow(
    'Unknown background command bg-9. It may have ended with a restart or session close.',
  )
})

test('stopAll ends every running job without starting a delivery run', async () => {
  const delivered: string[] = []
  const reports: BackgroundResult[] = []
  const session = sessionStub(directory(), delivered)
  bind(session, (_session, result) => {
    reports.push(result)
  })
  const jobs = new BackgroundJobs(session, () => 'bash', silentLogger)
  jobs.start('sleep 30')
  jobs.start('sleep 30')
  await jobs.stopAll()
  expect(jobs.snapshot('bg-1')).toMatchObject({
    state: 'exited',
    stopped: true,
  })
  expect(jobs.snapshot('bg-2')).toMatchObject({
    state: 'exited',
    stopped: true,
  })
  await Bun.sleep(50)
  expect(reports).toEqual([])
  expect(delivered).toEqual([])
})

test('outside channels the exit is a custom message that starts a turn', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('background_start', { command: 'sleep 0.2; echo READY' }),
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
    session: {
      tools: ['background_start', 'background_output', 'background_stop'],
    },
  })
  await t.run('start the check')
  await until(() => t.model.calls.length === 3, 'the delivery turn')
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain('Started bg-1')
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
      fauxToolCall('background_start', {
        // A killed process never writes the marker; a surviving one does.
        command: 'sleep 0.3; echo late > late.txt',
      }),
      () => {
        void t.session.abort(new DOMException('stopped', 'AbortError'))
        return fauxText('never')
      },
    ],
    extensions: [background()],
    session: { tools: ['background_start', 'background_output'] },
    allowPendingResponses: true,
  })
  await t.run('start it').catch(() => {})
  await Bun.sleep(600)
  expect(t.exists('late.txt')).toBe(false)
})
