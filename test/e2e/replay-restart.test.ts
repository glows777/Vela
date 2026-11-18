import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
const root = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'vela-replay-restart-'))
  roots.push(cwd)
  return cwd
}
const attempts = (cwd: string): { id: string }[] =>
  readFileSync(join(cwd, 'attempts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))

/** Each attempt runs in a fresh process; SIGKILL bypasses normal abort and cleanup paths. */
async function processAttempt(
  cwd: string,
  mode: string,
  kill: boolean,
  policy = 'safe',
) {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL('../fixtures/recovery/replay.ts', import.meta.url).pathname,
      cwd,
      mode,
      policy,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const stderr = new Response(child.stderr).text()
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
  let output = ''
  try {
    for await (const chunk of child.stdout) {
      output += new TextDecoder().decode(chunk)
      if (kill && output.includes('CALL_READY')) {
        child.kill('SIGKILL')
        break
      }
    }
    const exitCode = await child.exited
    const errors = await stderr
    if (kill) {
      if (!output.includes('CALL_READY'))
        throw new Error(`Call never started: ${output}\n${errors}`)
    } else {
      expect(exitCode, errors).toBe(0)
      expect(output).toContain('RECOVERY_DONE')
    }
  } finally {
    clearTimeout(timeout)
    child.kill('SIGKILL')
    await child.exited
  }
}

test('safe interrupted tools replay in a fresh process with the original logical call id', async () => {
  const cwd = root()
  await processAttempt(cwd, 'start', true)
  await processAttempt(cwd, 'complete', false)
  expect(attempts(cwd)).toEqual([
    { id: 'original-call' },
    { id: 'original-call' },
  ])
  const request = readFileSync(join(cwd, 'recovered-request.json'), 'utf8')
  expect(request).toContain('resource read successfully')
  const messages = JSON.parse(
    readFileSync(join(cwd, 'recovered-messages.json'), 'utf8'),
  )
  expect(
    messages.filter((message: { role: string }) => message.role === 'user'),
  ).toHaveLength(1)
  expect(
    messages.filter((message: { role: string }) => message.role === 'tool'),
  ).toHaveLength(1)
})

test('five real process interruptions stop replay before a sixth execution', async () => {
  const cwd = root()
  await processAttempt(cwd, 'start', true)
  for (let restart = 1; restart < 5; restart++)
    await processAttempt(cwd, 'resume', true)
  await processAttempt(cwd, 'resume', false)
  expect(attempts(cwd)).toHaveLength(5)
  expect(new Set(attempts(cwd).map((attempt) => attempt.id))).toEqual(
    new Set(['original-call']),
  )
  expect(readFileSync(join(cwd, 'recovered-request.json'), 'utf8')).toContain(
    'interrupted 5 times in a row; it is not run again',
  )
}, 15000)

test('a formerly safe tool is not replayed when its current registration is unsafe', async () => {
  const cwd = root()
  await processAttempt(cwd, 'start', true)
  await processAttempt(cwd, 'resume', false, 'unsafe')
  expect(attempts(cwd)).toEqual([{ id: 'original-call' }])
  expect(readFileSync(join(cwd, 'recovered-request.json'), 'utf8')).toContain(
    'may have partially run',
  )
})
