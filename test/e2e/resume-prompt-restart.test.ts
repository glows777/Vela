import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../packages/vela/src/db/sqlite.ts'
import { projectDataDir } from '../../packages/vela/src/driver/config/paths.ts'

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
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'vela-resume-prompt-')))
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
  const db = openDatabase({
    path: join(projectDataDir(join(cwd, 'agent'), cwd), 'vela.db'),
    readonly: true,
  })
  try {
    const rows = db.all<{ content_json: string }>(
      "SELECT content_json FROM vela_messages WHERE session_id = 'resume-prompt' AND kind = 'message' ORDER BY seq",
    )
    const users = rows
      .map(
        (row) =>
          JSON.parse(row.content_json) as { role: string; content: unknown },
      )
      .filter(
        (message) => message.role === 'user' && message.content === followup,
      )
    expect(users).toHaveLength(1)
    const dump = JSON.stringify(rows)
    expect(dump).toContain('FINISHED_FIRST')
    expect(dump).toContain('interrupted by a restart')
    expect(dump).toContain('may have partially run')
  } finally {
    db.close()
  }
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
  const dbPath = join(projectDataDir(join(cwd, 'agent'), cwd), 'vela.db')
  const db = openDatabase({ path: dbPath })
  const countRows = () =>
    db.all<{ id: string }>(
      "SELECT id FROM vela_messages WHERE session_id = 'resume-prompt' ORDER BY seq",
    )
  const parent = db.get<{ id: string; seq: number }>(
    "SELECT id, seq FROM vela_messages WHERE session_id = 'resume-prompt' ORDER BY seq DESC LIMIT 1",
  )!
  const corruptId = crypto.randomUUID().slice(0, 8)
  db.run(
    `INSERT INTO vela_messages (
      id, session_id, parent_id, seq, kind, role, content_json, include_in_context, created_at
    ) VALUES (?, 'resume-prompt', ?, ?, 'message', 'user', ?, 1, ?)`,
    corruptId,
    parent.id,
    parent.seq + 1,
    JSON.stringify({
      role: 'user',
      content: 'Previously saved follow-up from the broken version',
    }),
    new Date().toISOString(),
  )
  db.run(
    "UPDATE sessions SET leaf_message_id = ? WHERE id = 'resume-prompt'",
    corruptId,
  )
  const before = countRows()
  db.close()
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
  const check = openDatabase({ path: dbPath, readonly: true })
  try {
    expect(
      check.all<{ id: string }>(
        "SELECT id FROM vela_messages WHERE session_id = 'resume-prompt' ORDER BY seq",
      ),
    ).toEqual(before)
  } finally {
    check.close()
  }
  expect(readFileSync(join(cwd, 'sideeffects'), 'utf8')).toBe('started\n')
  expect(readFileSync(join(cwd, 'first-count'), 'utf8')).toBe('first\n')
  expect(existsSync(join(cwd, 'finished'))).toBe(false)
}, 30000)
