import { afterEach, expect, test } from 'bun:test'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectDataDir } from '../../packages/core/src/config/paths.ts'

const roots: string[] = []
const entry = new URL('../../packages/vela/src/cli/main.ts', import.meta.url)
  .pathname
const fixture = new URL(
  '../fixtures/recovery/resume-prompt.ts',
  import.meta.url,
).pathname
const followup = 'What happened? Do not repeat the commands.'
afterEach(() => {
  for (const cwd of roots.splice(0))
    rmSync(cwd, { recursive: true, force: true })
})
async function crash() {
  const cwd = mkdtempSync(join(tmpdir(), 'vela-resume-prompt-'))
  roots.push(cwd)
  const child = Bun.spawn([process.execPath, fixture, cwd, 'start'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const errors = new Response(child.stderr).text()
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
  let output = ''
  try {
    for await (const chunk of child.stdout) {
      output += new TextDecoder().decode(chunk)
      if (output.includes('CRASH_READY')) break
    }
    if (!output.includes('CRASH_READY'))
      throw new Error(`Crash fixture failed: ${output}\n${await errors}`)
  } finally {
    clearTimeout(timer)
    child.kill('SIGKILL')
    await child.exited
    // The worker is deliberately SIGKILLed; reap its detached shell group explicitly.
    if (existsSync(join(cwd, 'bash.pid'))) {
      try {
        process.kill(
          -Number(readFileSync(join(cwd, 'bash.pid'), 'utf8').trim()),
          'SIGKILL',
        )
      } catch {}
    }
  }
  return cwd
}
function verify(cwd: string) {
  expect(readFileSync(join(cwd, 'first-count'), 'utf8')).toBe('first\n')
  expect(readFileSync(join(cwd, 'sideeffects'), 'utf8')).toBe('started\n')
  expect(existsSync(join(cwd, 'finished'))).toBe(false)
  const transcript = readFileSync(
    join(
      projectDataDir(join(cwd, 'agent'), cwd),
      'sessions/resume-prompt/transcript.jsonl',
    ),
    'utf8',
  )
  const entries = transcript
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const users = entries.filter(
    (entry) =>
      entry.type === 'message' &&
      entry.message.role === 'user' &&
      entry.message.content === followup,
  )
  expect(users).toHaveLength(1)
  expect(transcript).toContain('FINISHED_FIRST')
  expect(transcript).toContain('interrupted by a restart')
  expect(transcript).toContain('may have partially run')
}

test('SIGKILL then SDK resume and normal prompt repairs the interrupted unsafe tail before adding one new user message', async () => {
  const cwd = await crash()
  const child = Bun.spawn([process.execPath, fixture, cwd, 'resume'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timer)
  expect(code, stderr).toBe(0)
  expect(stdout).toContain('RECOVERED')
  const request = readFileSync(join(cwd, 'request.json'), 'utf8')
  expect(request).toContain('FINISHED_FIRST')
  expect(request).toContain('may have partially run')
  verify(cwd)
}, 30000)

for (const mode of ['text', 'json', 'rpc']) {
  test(`SIGKILL then CLI ${mode} session resume accepts a normal follow-up without replay`, async () => {
    const cwd = await crash()
    mkdirSync(join(cwd, 'home'))
    writeFileSync(
      join(cwd, 'scenario.json'),
      JSON.stringify({ responses: [{ text: 'RECOVERED' }] }),
    )
    const child = Bun.spawn(
      [
        process.execPath,
        entry,
        '--mode',
        mode,
        '--session',
        'resume-prompt',
        '--no-extensions',
        ...(mode === 'rpc' ? [] : [followup]),
      ],
      {
        cwd,
        env: {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          HOME: join(cwd, 'home'),
          VELA_DIR: join(cwd, 'agent'),
          VELA_MODEL: `faux:${join(cwd, 'scenario.json')}`,
        },
        stdin: mode === 'rpc' ? 'pipe' : 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
    const stderr = new Response(child.stderr).text()
    let stdout = ''
    try {
      if (mode === 'rpc') {
        child.stdin?.write(
          `${JSON.stringify({ id: 'followup', type: 'prompt', message: followup })}\n`,
        )
        child.stdin?.flush()
        for await (const chunk of child.stdout) {
          stdout += new TextDecoder().decode(chunk)
          if (stdout.includes('"type":"agent_settled"')) {
            child.stdin?.end()
            break
          }
        }
      } else stdout = await new Response(child.stdout).text()
      const code = await child.exited
      const errors = await stderr
      expect(code, errors + stdout).toBe(0)
      expect(stdout).toContain('RECOVERED')
      expect(errors + stdout).not.toContain('MissingToolResultsError')
      verify(cwd)
    } finally {
      clearTimeout(timer)
      child.kill('SIGKILL')
      await child.exited
    }
  }, 40000)
}

test('historically saved user input after an unresolved tool call is rejected without changing history or replaying effects', async () => {
  const cwd = await crash()
  const transcriptPath = join(
    projectDataDir(join(cwd, 'agent'), cwd),
    'sessions/resume-prompt/transcript.jsonl',
  )
  const entries = readFileSync(transcriptPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  // This is the ordinary SessionMessageEntry emitted by the old broken prompt path:
  // a user child of the unresolved assistant call, without its required tool result.
  appendFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: 'message',
      id: crypto.randomUUID().slice(0, 8),
      parentId: entries.at(-1).id,
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: 'Previously saved follow-up from the broken version',
      },
    })}\n`,
  )
  const before = readFileSync(transcriptPath)
  const child = Bun.spawn([process.execPath, fixture, cwd, 'historical'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000)
  const [stderr, code] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timeout)
  expect(code, stderr).toBe(0)
  const rejected = JSON.parse(readFileSync(join(cwd, 'rejection.json'), 'utf8'))
  expect(rejected.error).toContain(
    'Saved history has a user message before unresolved tool results',
  )
  expect(rejected.error).toContain('Open a new session')
  expect(rejected.modelCalls).toBe(0)
  expect(existsSync(join(cwd, 'request.json'))).toBe(false)
  expect(readFileSync(transcriptPath)).toEqual(before)
  expect(readFileSync(join(cwd, 'sideeffects'), 'utf8')).toBe('started\n')
  expect(readFileSync(join(cwd, 'first-count'), 'utf8')).toBe('first\n')
  expect(existsSync(join(cwd, 'finished'))).toBe(false)
}, 30000)
