import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { projectDataDir } from '../../src/config/index.ts'
import { tempDir } from '../support/vela.ts'

const ROOT = resolve(import.meta.dir, '../..')
const ENTRY = join(ROOT, 'src/cli/main.ts')
const scenario = (name: string) =>
  join(ROOT, 'test/fixtures/scenarios', `${name}.json`)

// Every test spawns a CLI process and they run concurrently; with a dozen processes starting at once on slow CI machines, the default 5 s is not enough
setDefaultTimeout(30_000)

const dirs: { cleanup(): void }[] = []
// Tests run concurrently (each spawns a process), so temp dirs are cleaned up once at the end
afterAll(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

/**
 * Starts a real CLI process in a temp dir. The user dir (VELA_DIR, also HOME) is another temp dir,
 * so the real ~/.vela is never touched; the data dir is `<VELA_DIR>/projects/<encoded cwd>`.
 */
async function cli(
  args: string[],
  options: {
    model: string
    cwd?: string
    agentDir?: string
    files?: Record<string, string>
    env?: Record<string, string>
    stdin?: string
    /** Run in a pseudo-terminal (interactive mode): once the first item appears on screen, type the second (in order) */
    terminal?: [waitFor: string, send: string][]
  },
) {
  let cwd = options.cwd
  if (!cwd) {
    const dir = tempDir('vela-cli-')
    dirs.push(dir)
    cwd = dir.path
  }
  let agentDir = options.agentDir
  if (!agentDir) {
    const dir = tempDir('vela-home-')
    dirs.push(dir)
    agentDir = dir.path
  }
  for (const [path, content] of Object.entries(options.files ?? {}))
    await Bun.write(join(cwd, path), content)
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: agentDir,
    VELA_DIR: agentDir,
    VELA_MODEL: options.model,
    ...options.env,
  }
  const command = ['bun', ENTRY, ...args]
  if (options.terminal) {
    const proc = Bun.spawn(
      ['script', '-qec', command.map((a) => `'${a}'`).join(' '), '/dev/null'],
      { cwd, env, stdout: 'pipe', stderr: 'pipe', stdin: 'pipe' },
    )
    const steps = [...options.terminal]
    let stdout = ''
    const decoder = new TextDecoder()
    for await (const chunk of proc.stdout) {
      stdout += decoder.decode(chunk, { stream: true })
      const screen = stripTerminalSequences(stdout)
      while (steps.length && screen.includes(steps[0]![0])) {
        proc.stdin.write(steps.shift()![1])
        await proc.stdin.flush()
      }
    }
    const [stderr, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return {
      stdout: stripTerminalSequences(stdout),
      stderr,
      code,
      cwd,
      agentDir,
      dataDir: projectDataDir(agentDir, cwd),
    }
  }
  const proc = Bun.spawn(command, {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin:
      options.stdin === undefined
        ? 'ignore'
        : new TextEncoder().encode(options.stdin),
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return {
    stdout,
    stderr,
    code,
    cwd,
    agentDir,
    dataDir: projectDataDir(agentDir, cwd),
  }
}

/** Session files saved in the data dir (each run starts a new session; the id is a timestamp + random suffix) */
function sessionFiles(dataDir: string): string[] {
  try {
    return readdirSync(join(dataDir, 'sessions'))
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => join(dataDir, 'sessions', name))
  } catch {
    return []
  }
}

test.concurrent('-p prints only the final answer to stdout and saves a new session', async () => {
  const { stdout, code, dataDir } = await cli(['-p', 'hello'], {
    model: `faux:${scenario('hello')}`,
  })
  expect(code).toBe(0)
  // Like pi: stdout holds only the final answer; diagnostics go to stderr
  expect(stdout).toBe('Hello, this is Vela (faux replay).\n')
  const files = sessionFiles(dataDir)
  expect(files).toHaveLength(1)
  expect(files[0]).toMatch(/\/\d{8}-\d{6}-[0-9a-f]{4}\.jsonl$/)
  expect(await Bun.file(files[0]!).text()).toContain('faux replay')
})

test.concurrent('-p executes tools from the scenario in the process working directory', async () => {
  const { stdout, code } = await cli(['-p', 'check notes.txt'], {
    model: `faux:${scenario('read-file')}`,
    files: { 'notes.txt': 'remember the milk' },
  })
  expect(code).toBe(0)
  expect(stdout).toBe('notes.txt says remember the milk\n')
})

test.concurrent('piped stdin is prepended to the prompt (print mode without -p)', async () => {
  const { stdout, code, dataDir } = await cli(['summarize this'], {
    model: `faux:${scenario('hello')}`,
    stdin: 'some piped input',
  })
  expect(code).toBe(0)
  expect(stdout).toBe('Hello, this is Vela (faux replay).\n')
  const saved = await Bun.file(sessionFiles(dataDir)[0]!).text()
  expect(saved).toContain('some piped input\\n\\nsummarize this')
})

test.concurrent('--mode json writes a session header and one JSON event per line', async () => {
  const { stdout, code } = await cli(['--mode', 'json', 'check notes.txt'], {
    model: `faux:${scenario('read-file')}`,
    files: { 'notes.txt': 'remember the milk' },
  })
  expect(code).toBe(0)
  const records = stdout.trim().split('\n').map((line) => JSON.parse(line))
  expect(records[0]).toMatchObject({ type: 'session', thinkingLevel: 'medium' })
  const id = records[0].id
  expect(records.slice(1).every((r) => r.sessionId === id)).toBe(true)
  expect(records.find((r) => r.type === 'tool_call')).toMatchObject({
    toolName: 'read_file',
    input: { path: 'notes.txt' },
  })
  expect(records.at(-1)).toEqual({ type: 'agent_settled', sessionId: id })
})

test.concurrent('--mode json reports a model error in agent_end and exits 1', async () => {
  const { stdout, code, stderr } = await cli(['--mode', 'json', 'hi'], {
    model: `faux:${scenario('bad-request')}`,
  })
  expect(code).toBe(1)
  const end = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((r) => r.type === 'agent_end')
  expect(end.reason).toBe('error')
  expect(end.error.message).toContain('400 Bad Request')
  expect(stderr).toContain('400 Bad Request')
})

// Cold-starts the CLI several times; alongside other concurrent tests on CI each takes 2-3 s, more than the default 5 s
test.concurrent('each run starts a new session; -c continues the most recent one', async () => {
  const first = await cli(['-p', 'first message'], {
    model: `faux:${scenario('hello')}`,
  })
  const second = await cli(['-p', 'second message'], {
    model: `faux:${scenario('hello')}`,
    cwd: first.cwd,
    agentDir: first.agentDir,
  })
  const third = await cli(['-p', 'third message', '-c'], {
    model: `faux:${scenario('hello')}`,
    cwd: first.cwd,
    agentDir: first.agentDir,
  })
  expect(third.code).toBe(0)
  const files = sessionFiles(first.dataDir)
  expect(files).toHaveLength(2)
  const contents = await Promise.all(files.map((f) => Bun.file(f).text()))
  expect(contents.some((c) => c.includes('first message') && !c.includes('second message'))).toBe(true)
  expect(contents.some((c) => c.includes('second message') && c.includes('third message'))).toBe(true)
  expect(second.code).toBe(0)
  // Three CLI processes; alongside other concurrent tests the default 5 s is not enough
}, 20_000)

test.concurrent('-c -p with a command prints nothing on stdout, not the previous answer', async () => {
  const first = await cli(['-p', 'hello'], { model: `faux:${scenario('hello')}` })
  expect(first.code).toBe(0)
  const dir = tempDir('vela-ext-')
  dirs.push(dir)
  const ping = join(dir.path, 'ping.ts')
  await Bun.write(
    ping,
    `export default (vela) => vela.registerCommand('ping', { handler: async (_args, ctx) => ctx.ui.notify('pong') })`,
  )
  const second = await cli(['-c', '-p', '/ping', '-e', ping], {
    model: `faux:${scenario('hello')}`,
    cwd: first.cwd,
    agentDir: first.agentDir,
  })
  expect(second.code).toBe(0)
  expect(second.stderr).toContain('pong')
  // The previous answer is in the resumed history, but this run did not produce it
  expect(second.stdout).toBe('')
}, 20_000)

test.concurrent('--session opens a named session id; -r needs interactive mode', async () => {
  const first = await cli(['-p', 'hello', '--session', 'work'], {
    model: `faux:${scenario('hello')}`,
  })
  expect(first.code).toBe(0)
  expect(sessionFiles(first.dataDir).map((f) => f.split('/').at(-1))).toEqual([
    'work.jsonl',
  ])
  const resume = await cli(['-p', 'hello', '-r'], {
    model: `faux:${scenario('hello')}`,
  })
  expect(resume.code).toBe(2)
  expect(resume.stderr).toContain('-r works only in interactive mode')
  const bad = await cli(['-p', 'hello', '--session', '.bad'], {
    model: `faux:${scenario('hello')}`,
  })
  expect(bad.code).toBe(2)
  expect(bad.stderr).toContain('Invalid session id ".bad"')
  expect(bad.stderr).not.toMatch(/\n\s+at /)
})

test.concurrent('a model error makes -p exit 1 with the real cause on stderr', async () => {
  const { code, stderr } = await cli(['-p', 'hi'], {
    model: `faux:${scenario('bad-request')}`,
  })
  expect(code).toBe(1)
  expect(stderr).toContain('[Agent] Turn stopped: 400 Bad Request: model not found')
})

test.concurrent('-p without a prompt prints usage and exits 2', async () => {
  const { code, stderr } = await cli(['-p'], {
    model: `faux:${scenario('hello')}`,
  })
  expect(code).toBe(2)
  expect(stderr).toContain('No prompt')
  expect(stderr).toContain('Usage')
})

test.concurrent('--help and --version print to stdout and exit 0 before any setup', async () => {
  // A broken settings.json and no model must not matter: these exit before config and model are read
  const files = { '.vela/settings.json': '{ broken' }
  for (const flag of ['--help', '-h']) {
    const { stdout, stderr, code } = await cli([flag], { model: '', files })
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toContain('Usage:')
    expect(stdout).toContain('--version')
    expect(stdout).toContain('Examples:')
  }
  const { version } = await Bun.file(join(ROOT, 'package.json')).json()
  for (const flag of ['--version', '-v']) {
    const { stdout, stderr, code } = await cli([flag], { model: '', files })
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toBe(`${version}\n`)
  }
})

const GREET = (label: string) =>
  `export default function (vela) { vela.logger.info(\`[${label}] loaded \${JSON.stringify(vela.config)}\`) }`

test.concurrent('extensions are discovered in ~/.vela/extensions and configured from settings.json with $VAR', async () => {
  const home = tempDir('vela-home-')
  dirs.push(home)
  await Bun.write(join(home.path, 'extensions/greet.ts'), GREET('greet'))
  await Bun.write(
    join(home.path, 'settings.json'),
    JSON.stringify({ extensionConfig: { greet: { token: '$GREET_TOKEN' } } }),
  )
  const { stderr, code } = await cli(['-p', 'hello'], {
    model: `faux:${scenario('hello')}`,
    agentDir: home.path,
    env: { GREET_TOKEN: 't0k' },
  })
  expect(code).toBe(0)
  expect(stderr).toContain('[greet] loaded {"token":"t0k"}')
})

test.concurrent('project extensions load only when the project is trusted', async () => {
  const files = { '.vela/extensions/local.ts': GREET('local') }
  const skipped = await cli(['-p', 'hello'], {
    model: `faux:${scenario('hello')}`,
    files,
  })
  expect(skipped.code).toBe(0)
  expect(skipped.stderr).not.toContain('[local] loaded')
  expect(skipped.stderr).toContain('[trust] Did not load')

  const approved = await cli(['-p', 'hello', '--approve'], {
    model: `faux:${scenario('hello')}`,
    files,
  })
  expect(approved.code).toBe(0)
  expect(approved.stderr).toContain('[local] loaded')
  expect(approved.stderr).not.toContain('[trust]')

  // A saved decision
  const home = tempDir('vela-home-')
  dirs.push(home)
  const project = tempDir('vela-cli-')
  dirs.push(project)
  await Bun.write(
    join(home.path, 'trust.json'),
    JSON.stringify({ [project.path]: true }),
  )
  const saved = await cli(['-p', 'hello'], {
    model: `faux:${scenario('hello')}`,
    files,
    cwd: project.path,
    agentDir: home.path,
  })
  expect(saved.stderr).toContain('[local] loaded')
}, 20_000)

test.concurrent('-e loads an extension file; --no-extensions drops built-in and discovered ones', async () => {
  const dir = tempDir('vela-ext-')
  dirs.push(dir)
  const extra = join(dir.path, 'extra.ts')
  await Bun.write(extra, GREET('extra'))
  const { stderr, code } = await cli(
    ['-p', 'hello', '--no-extensions', '-e', extra],
    { model: `faux:${scenario('hello')}` },
  )
  expect(code).toBe(0)
  expect(stderr).toContain('[extra] loaded {}')
  // The built-in rag extension did not load (it announces that embedding is not configured when it does)
  expect(stderr).not.toContain('[rag]')
})

test.concurrent('--no-session keeps the session in memory', async () => {
  const { code, dataDir } = await cli(['-p', 'hello', '--no-session'], {
    model: `faux:${scenario('hello')}`,
  })
  expect(code).toBe(0)
  expect(sessionFiles(dataDir)).toEqual([])
})

test.concurrent('a broken settings.json stops the CLI with the file name', async () => {
  const home = tempDir('vela-home-')
  dirs.push(home)
  await Bun.write(join(home.path, 'settings.json'), '{ nope')
  const { code, stderr } = await cli(['-p', 'hello'], {
    model: `faux:${scenario('hello')}`,
    agentDir: home.path,
  })
  expect(code).toBe(2)
  expect(stderr).toContain(`[config] ${join(home.path, 'settings.json')} is not valid JSON`)
})

test.concurrent('a broken trust.json stops the CLI instead of being ignored', async () => {
  const home = tempDir('vela-home-')
  dirs.push(home)
  await Bun.write(join(home.path, 'trust.json'), '{ nope')
  const { code, stderr } = await cli(['-p', 'hello'], {
    model: `faux:${scenario('hello')}`,
    agentDir: home.path,
    files: { '.vela/settings.json': '{}' },
  })
  expect(code).toBe(2)
  expect(stderr).toContain(`[config] ${join(home.path, 'trust.json')} is not valid JSON`)
})

// The demo model streams one character every 30 ms (about 2 s); with other concurrent tests on slow CI machines that exceeds the default 5 s
test.concurrent('VELA_MODEL=mock still runs the keyword demo model offline', async () => {
  const { code, stdout } = await cli(['-p', 'hello'], { model: 'mock' })
  expect(code).toBe(0)
  expect(stdout.trim()).not.toBe('')
}, 20_000)

// Interactive mode (TUI) only appears in a terminal (piped input uses print mode, like pi): util-linux `script` gives the child a pseudo-terminal.
// TUI behavior itself is tested with a fake terminal in e2e/tui; here we only check that it starts, chats and exits in a real terminal
const hasScript =
  process.platform === 'linux' && Bun.spawnSync(['script', '-V']).exitCode === 0

test.if(hasScript)(
  'interactive mode in a real terminal: a turn, then Ctrl+D exits and the session is saved',
  async () => {
    const { stdout, code, dataDir } = await cli([], {
      model: `faux:${scenario('hello')}`,
      terminal: [
        ['Ctrl+D exit', 'hello\r'],
        ['Hello, this is Vela (faux replay).', '\x04'],
      ],
    })
    expect(code).toBe(0)
    expect(stdout).toContain('Hello, this is Vela (faux replay).')
    const files = sessionFiles(dataDir)
    expect(files).toHaveLength(1)
    expect(await Bun.file(files[0]!).text()).toContain('hello')
  },
)

test.if(hasScript)(
  '-r lists saved sessions and resumes the chosen one',
  async () => {
    const first = await cli(['-p', 'hello'], {
      model: `faux:${scenario('hello')}`,
    })
    expect(first.code).toBe(0)
    const picked = await cli(['-r'], {
      model: `faux:${scenario('hello')}`,
      cwd: first.cwd,
      agentDir: first.agentDir,
      terminal: [
        ['Resume Session', '\r'],
        ['Resumed session', '\x04'],
      ],
    })
    expect(picked.code).toBe(0)
    // The resumed history is drawn, and the same session was resumed rather than saved as a new one
    expect(picked.stdout).toContain('Hello, this is Vela (faux replay).')
    expect(sessionFiles(first.dataDir)).toHaveLength(1)
  },
)

test.concurrent('VELA_RECORD records a run that VELA_MODEL=faux: replays offline', async () => {
  const dir = tempDir('vela-cli-')
  dirs.push(dir)
  const recorded = join(dir.path, 'recorded.json')
  const files = { 'notes.txt': 'remember the milk' }
  const first = await cli(['-p', 'read notes.txt'], {
    model: `faux:${scenario('read-file')}`,
    files,
    env: { VELA_RECORD: recorded },
  })
  expect(first.code).toBe(0)
  const saved = await Bun.file(recorded).json()
  expect(saved.inputs).toEqual(['read notes.txt'])
  expect(saved.responses).toHaveLength(2)

  const replay = await cli(['-p', 'read notes.txt'], {
    model: `faux:${recorded}`,
    files,
  })
  expect(replay.code).toBe(0)
  expect(replay.stdout).toContain('remember the milk')
  // Two CLI processes at 2-3 s each on CI; the default 5 s is not enough
}, 20_000)

test.concurrent('--model picks a provider registered by an extension; the choice is saved for --continue', async () => {
  const home = tempDir('vela-home-')
  dirs.push(home)
  await Bun.write(
    join(home.path, 'extensions/local.ts'),
    `import { createFauxModel, fauxText } from ${JSON.stringify(join(ROOT, 'src/testing/faux'))}
export default (vela) => vela.registerProvider('local', {
  models: [{ id: 'm', contextWindow: 32768 }],
  createModel: (id) => createFauxModel({ modelId: id, responses: [(req) => fauxText('from ' + id + ' ' + (req.reasoning ?? '-'))] }),
})
`,
  )
  const first = await cli(['-p', 'hello', '--model', 'local/m', '--thinking', 'high'], {
    model: '',
    agentDir: home.path,
  })
  expect(first.stderr).not.toContain('[model]')
  expect(first.code).toBe(0)
  expect(first.stdout).toBe('from m high\n')

  // No --model: the model and thinking level saved in the session are restored; OPENAI_API_MODEL_NAME is not needed
  const second = await cli(['-p', 'again', '--continue'], {
    model: '',
    cwd: first.cwd,
    agentDir: home.path,
  })
  expect(second.stderr).not.toContain('[model]')
  expect(second.code).toBe(0)
  expect(second.stdout).toContain('from m high')

  // A VELA_MODEL=faux replay is not overridden by the saved model
  const third = await cli(['-p', 'hello', '--continue'], {
    model: `faux:${scenario('hello')}`,
    cwd: first.cwd,
    agentDir: home.path,
  })
  expect(third.code).toBe(0)
  expect(third.stdout).not.toContain('from m')
  // Three CLI processes
}, 20_000)

test.concurrent('an unknown --model or no model at all stops with a clear message', async () => {
  const unknown = await cli(['-p', 'hello', '--model', 'nope/x'], { model: '' })
  expect(unknown.code).toBe(1)
  expect(unknown.stderr).toContain('[model] No provider named nope')

  const none = await cli(['-p', 'hello'], { model: '' })
  expect(none.code).toBe(1)
  expect(none.stderr).toContain('No model selected')

  const missingKey = await cli(['-p', 'hello', '--model', 'anthropic/claude-x'], {
    model: '',
  })
  expect(missingKey.code).toBe(1)
  expect(missingKey.stderr).toContain('ANTHROPIC_API_KEY')

  const badThinking = await cli(['-p', 'hello', '--thinking', 'huge'], {
    model: `faux:${scenario('hello')}`,
  })
  expect(badThinking.code).toBe(2)
  expect(badThinking.stderr).toContain('--thinking must be one of')
})

test.concurrent('a reader that closes stdout early makes the CLI exit quietly', async () => {
  const dir = tempDir('vela-pipe-')
  dirs.push(dir)
  const home = tempDir('vela-home-')
  dirs.push(home)
  // An answer far larger than a pipe buffer, so the CLI is still writing when `head` exits
  const long = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\n')
  const file = join(dir.path, 'long.json')
  await Bun.write(file, JSON.stringify({ responses: [{ text: long }] }))
  const run = async (args: string, lines: number) => {
    const proc = Bun.spawn(
      // The CLI's pid and exit code go to files (the pipeline's code is head's); if the CLI hangs, the timer kills it
      ['sh', '-c', `{ bun '${ENTRY}' ${args} < /dev/null & echo $! > pid; wait $!; echo $? > status; } | head -${lines}`],
      {
        cwd: dir.path,
        env: { PATH: process.env.PATH ?? '', HOME: home.path, VELA_DIR: home.path, VELA_MODEL: `faux:${file}` },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const timer = setTimeout(async () => {
      process.kill(Number(await Bun.file(join(dir.path, 'pid')).text()), 'SIGKILL')
    }, 15_000)
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    clearTimeout(timer)
    expect(code).toBe(0)
    return { stdout, stderr, code: Number(await Bun.file(join(dir.path, 'status')).text()) }
  }
  const json = await run('--mode json hi', 3)
  expect(json.code).toBe(0)
  expect(json.stdout.split('\n').slice(0, 1).map((l) => JSON.parse(l).type)).toEqual(['session'])
  expect(json.stderr).not.toContain('EPIPE')
  const print = await run('-p hi', 2)
  expect(print.code).toBe(0)
  expect(print.stdout).toStartWith('line 0\nline 1\n')
  expect(print.stderr).not.toContain('EPIPE')
})
