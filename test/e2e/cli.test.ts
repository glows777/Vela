import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { projectDataDir } from '../../src/config'
import { tempDir } from '../support/vela'

const ROOT = resolve(import.meta.dir, '../..')
const ENTRY = join(ROOT, 'src/cli/main.ts')
const scenario = (name: string) =>
  join(ROOT, 'test/fixtures/scenarios', `${name}.json`)

// 每个用例都起 CLI 子进程且并发运行；CI 的慢机器上十几个进程一起启动，默认 5 秒不够
setDefaultTimeout(30_000)

const dirs: { cleanup(): void }[] = []
// 用例并发运行（每个都要起进程），统一在最后清理临时目录
afterAll(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

/**
 * 在临时目录里起一个真实的 CLI 进程。用户级目录（VELA_DIR，也是 HOME）是另一个临时目录，
 * 不碰真实的 ~/.vela；数据目录是 `<VELA_DIR>/projects/<编码后的 cwd>`。
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
  const proc = Bun.spawn(['bun', ENTRY, ...args], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
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

test.concurrent('-p runs one turn with a faux scenario, prints the answer and exits 0', async () => {
  const { stdout, code, dataDir } = await cli(['-p', '你好'], {
    model: `faux:${scenario('hello')}`,
  })
  expect(code).toBe(0)
  expect(stdout).toContain('你好，我是 Vela（faux 回放）。')
  expect(stdout).toContain('Agent has completed its response')
  expect(await Bun.file(join(dataDir, 'sessions/default.jsonl')).text()).toContain(
    'faux 回放',
  )
})

test.concurrent('-p executes tools from the scenario in the process working directory', async () => {
  const { stdout, code } = await cli(['-p', '看看 notes.txt'], {
    model: `faux:${scenario('read-file')}`,
    files: { 'notes.txt': 'remember the milk' },
  })
  expect(code).toBe(0)
  expect(stdout).toContain('[tool called: read_file->({"path":"notes.txt"})]')
  expect(stdout).toContain('remember the milk')
})

// 两次冷启动 CLI；CI 上和其它并发用例一起，每次 2-3 秒，会超过默认 5 秒
test.concurrent('--continue resumes the saved session before the next prompt', async () => {
  const first = await cli(['-p', '第一句'], {
    model: `faux:${scenario('hello')}`,
  })
  const second = await cli(['-p', '第二句', '--continue'], {
    model: `faux:${scenario('hello')}`,
    cwd: first.cwd,
    agentDir: first.agentDir,
  })
  expect(second.code).toBe(0)
  const session = await Bun.file(
    join(first.dataDir, 'sessions/default.jsonl'),
  ).text()
  expect(session).toContain('第一句')
  expect(session).toContain('第二句')
  // 两次启动 CLI 子进程，和其它并发用例一起时默认 5 秒不够
}, 20_000)

test.concurrent('a model error makes -p exit 1 with the real cause on stderr', async () => {
  const { code, stderr } = await cli(['-p', 'hi'], {
    model: `faux:${scenario('bad-request')}`,
  })
  expect(code).toBe(1)
  expect(stderr).toContain('[Agent] 本轮停止: 400 Bad Request: model not found')
})

test.concurrent('-p without a prompt prints usage and exits 2', async () => {
  const { code, stderr } = await cli(['-p'], {
    model: `faux:${scenario('hello')}`,
  })
  expect(code).toBe(2)
  expect(stderr).toContain('用法')
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
  const { stdout, code } = await cli(['-p', '你好'], {
    model: `faux:${scenario('hello')}`,
    agentDir: home.path,
    env: { GREET_TOKEN: 't0k' },
  })
  expect(code).toBe(0)
  expect(stdout).toContain('[greet] loaded {"token":"t0k"}')
})

test.concurrent('project extensions load only when the project is trusted', async () => {
  const files = { '.vela/extensions/local.ts': GREET('local') }
  const skipped = await cli(['-p', '你好'], {
    model: `faux:${scenario('hello')}`,
    files,
  })
  expect(skipped.code).toBe(0)
  expect(skipped.stdout).not.toContain('[local] loaded')
  expect(skipped.stderr).toContain('[信任] 没有加载')

  const approved = await cli(['-p', '你好', '--approve'], {
    model: `faux:${scenario('hello')}`,
    files,
  })
  expect(approved.code).toBe(0)
  expect(approved.stdout).toContain('[local] loaded')
  expect(approved.stderr).not.toContain('[信任]')

  // 保存过的决定
  const home = tempDir('vela-home-')
  dirs.push(home)
  const project = tempDir('vela-cli-')
  dirs.push(project)
  await Bun.write(
    join(home.path, 'trust.json'),
    JSON.stringify({ [project.path]: true }),
  )
  const saved = await cli(['-p', '你好'], {
    model: `faux:${scenario('hello')}`,
    files,
    cwd: project.path,
    agentDir: home.path,
  })
  expect(saved.stdout).toContain('[local] loaded')
}, 20_000)

test.concurrent('-e loads an extension file; --no-extensions drops built-in and discovered ones', async () => {
  const dir = tempDir('vela-ext-')
  dirs.push(dir)
  const extra = join(dir.path, 'extra.ts')
  await Bun.write(extra, GREET('extra'))
  const { stdout, code } = await cli(
    ['-p', '你好', '--no-extensions', '-e', extra],
    { model: `faux:${scenario('hello')}` },
  )
  expect(code).toBe(0)
  expect(stdout).toContain('[extra] loaded {}')
  // supabase 内置扩展没加载（它加载时会提示 Mock 模式）
  expect(stdout).not.toContain('[supabase]')
})

test.concurrent('--no-session keeps the session in memory', async () => {
  const { code, dataDir } = await cli(['-p', '你好', '--no-session'], {
    model: `faux:${scenario('hello')}`,
  })
  expect(code).toBe(0)
  expect(await Bun.file(join(dataDir, 'sessions/default.jsonl')).exists()).toBe(
    false,
  )
})

test.concurrent('a broken settings.json stops the CLI with the file name', async () => {
  const home = tempDir('vela-home-')
  dirs.push(home)
  await Bun.write(join(home.path, 'settings.json'), '{ nope')
  const { code, stderr } = await cli(['-p', '你好'], {
    model: `faux:${scenario('hello')}`,
    agentDir: home.path,
  })
  expect(code).toBe(2)
  expect(stderr).toContain(`[配置] ${join(home.path, 'settings.json')} 不是合法的 JSON`)
})

// demo 模型按字符流式输出、每字 30ms（约 2 秒），在 CI 的慢机器上和其它并发用例一起会超过默认 5 秒
test.concurrent('VELA_MODEL=mock still runs the keyword demo model offline', async () => {
  const { code, stdout } = await cli(['-p', '你好'], { model: 'mock' })
  expect(code).toBe(0)
  expect(stdout).toContain('Agent has completed its response')
}, 20_000)

/** HOME 和 VELA_DIR 指向新的临时目录，不碰真实的 ~/.vela */
function isolatedHome(): { HOME: string; VELA_DIR: string } {
  const dir = tempDir('vela-home-')
  dirs.push(dir)
  return { HOME: dir.path, VELA_DIR: dir.path }
}

/** 交互模式：等到出现提示符再输入下一行，最后 exit */
async function repl(lines: string[], model: string) {
  const dir = tempDir('vela-repl-')
  dirs.push(dir)
  const home = isolatedHome()
  const proc = Bun.spawn(['bun', ENTRY], {
    cwd: dir.path,
    env: {
      PATH: process.env.PATH ?? '',
      ...home,
      VELA_MODEL: model,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let stdout = ''
  const decoder = new TextDecoder()
  const reader = proc.stdout.getReader()
  const prompts = () => stdout.split('You: ').length - 1
  const waitForPrompt = async (count: number) => {
    while (prompts() < count) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`CLI exited early:\n${stdout}`)
      stdout += decoder.decode(value)
    }
  }
  for (const [i, line] of [...lines, 'exit'].entries()) {
    await waitForPrompt(i + 1)
    proc.stdin.write(`${line}\n`)
    proc.stdin.flush()
  }
  proc.stdin.end()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    stdout += decoder.decode(value)
  }
  return {
    stdout,
    code: await proc.exited,
    dataDir: projectDataDir(home.VELA_DIR, dir.path),
  }
}

test.concurrent('interactive mode: a turn, a slash command, then exit', async () => {
  const { stdout, code, dataDir } = await repl(
    ['你好', '/memory'],
    `faux:${scenario('hello')}`,
  )
  expect(code).toBe(0)
  expect(stdout).toContain('[Session] 新会话')
  expect(stdout).toContain('你好，我是 Vela（faux 回放）。')
  expect(stdout).toContain('[Token]')
  expect(stdout).toContain('[记忆系统] 共 0 条记忆')
  expect(stdout).toContain('Bye!')
  expect(await Bun.file(join(dataDir, 'sessions/default.jsonl')).text()).toContain(
    '你好',
  )
})

test.concurrent('interactive mode reads piped stdin line by line and exits at EOF', async () => {
  const dir = tempDir('vela-pipe-')
  dirs.push(dir)
  const proc = Bun.spawn(['bun', ENTRY], {
    cwd: dir.path,
    env: {
      PATH: process.env.PATH ?? '',
      ...isolatedHome(),
      VELA_MODEL: `faux:${scenario('hello')}`,
    },
    stdin: new TextEncoder().encode('你好\n/memory\n'),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ])
  expect(code).toBe(0)
  expect(stdout).toContain('你好，我是 Vela（faux 回放）。')
  expect(stdout).toContain('[记忆系统] 共 0 条记忆')
  expect(stdout).toContain('Bye!')
})

test.concurrent('VELA_RECORD records a run that VELA_MODEL=faux: replays offline', async () => {
  const dir = tempDir('vela-cli-')
  dirs.push(dir)
  const recorded = join(dir.path, 'recorded.json')
  const files = { 'notes.txt': 'remember the milk' }
  const first = await cli(['-p', '读 notes.txt'], {
    model: `faux:${scenario('read-file')}`,
    files,
    env: { VELA_RECORD: recorded },
  })
  expect(first.code).toBe(0)
  const saved = await Bun.file(recorded).json()
  expect(saved.inputs).toEqual(['读 notes.txt'])
  expect(saved.responses).toHaveLength(2)

  const replay = await cli(['-p', '读 notes.txt'], {
    model: `faux:${recorded}`,
    files,
  })
  expect(replay.code).toBe(0)
  expect(replay.stdout).toContain('remember the milk')
  // 两次启动 CLI 子进程，CI 上每次 2~3 秒，默认 5 秒不够
}, 20_000)

test.concurrent('--model picks a provider registered by an extension; the choice is saved for --continue', async () => {
  const home = tempDir('vela-home-')
  dirs.push(home)
  await Bun.write(
    join(home.path, 'extensions/local.ts'),
    `import { createFauxModel, fauxText } from ${JSON.stringify(join(ROOT, 'src/testing/faux'))}
export default (vela) => vela.registerProvider('local', {
  models: [{ id: 'm', contextWindow: 32768 }],
  createModel: (id) => createFauxModel({ modelId: id, responses: [(req) => fauxText('来自 ' + id + ' ' + (req.reasoning ?? '-'))] }),
})
`,
  )
  const first = await cli(['-p', '你好', '--model', 'local/m', '--thinking', 'high'], {
    model: '',
    agentDir: home.path,
  })
  expect(first.stderr).toBe('')
  expect(first.code).toBe(0)
  expect(first.stdout).toContain('来自 m high')

  // 没给 --model：恢复会话里保存的模型和 thinking，不需要 OPENAI_API_MODEL_NAME
  const second = await cli(['-p', '再来', '--continue'], {
    model: '',
    cwd: first.cwd,
    agentDir: home.path,
  })
  expect(second.stderr).toBe('')
  expect(second.code).toBe(0)
  expect(second.stdout).toContain('来自 m high')
})

test.concurrent('an unknown --model or no model at all stops with a clear message', async () => {
  const unknown = await cli(['-p', '你好', '--model', 'nope/x'], { model: '' })
  expect(unknown.code).toBe(1)
  expect(unknown.stderr).toContain('[模型] 没有名为 nope 的 provider')

  const none = await cli(['-p', '你好'], { model: '' })
  expect(none.code).toBe(1)
  expect(none.stderr).toContain('没有选模型')

  const missingKey = await cli(['-p', '你好', '--model', 'anthropic/claude-x'], {
    model: '',
  })
  expect(missingKey.code).toBe(1)
  expect(missingKey.stderr).toContain('ANTHROPIC_API_KEY')

  const badThinking = await cli(['-p', '你好', '--thinking', 'huge'], {
    model: `faux:${scenario('hello')}`,
  })
  expect(badThinking.code).toBe(2)
  expect(badThinking.stderr).toContain('--thinking 只能是')
})
