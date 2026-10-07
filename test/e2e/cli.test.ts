import { afterAll, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { tempDir } from '../support/vela'

const ROOT = resolve(import.meta.dir, '../..')
const ENTRY = join(ROOT, 'src/index.ts')
const scenario = (name: string) =>
  join(ROOT, 'test/fixtures/scenarios', `${name}.json`)

const dirs: { cleanup(): void }[] = []
// 用例并发运行（每个都要起进程），统一在最后清理临时目录
afterAll(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

/** 在临时目录里起一个真实的 CLI 进程（数据目录 = 该目录） */
async function cli(
  args: string[],
  options: { model: string; cwd?: string; files?: Record<string, string> },
) {
  let cwd = options.cwd
  if (!cwd) {
    const dir = tempDir('vela-cli-')
    dirs.push(dir)
    cwd = dir.path
  }
  for (const [path, content] of Object.entries(options.files ?? {}))
    await Bun.write(join(cwd, path), content)
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    VELA_MODEL: options.model,
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
  return { stdout, stderr, code, cwd }
}

test.concurrent('-p runs one turn with a faux scenario, prints the answer and exits 0', async () => {
  const { stdout, code, cwd } = await cli(['-p', '你好'], {
    model: `faux:${scenario('hello')}`,
  })
  expect(code).toBe(0)
  expect(stdout).toContain('你好，我是 Vela（faux 回放）。')
  expect(stdout).toContain('Agent has completed its response')
  expect(await Bun.file(join(cwd, '.sessions/default.jsonl')).text()).toContain(
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

test.concurrent('--continue resumes the saved session before the next prompt', async () => {
  const first = await cli(['-p', '第一句'], {
    model: `faux:${scenario('hello')}`,
  })
  const second = await cli(['-p', '第二句', '--continue'], {
    model: `faux:${scenario('hello')}`,
    cwd: first.cwd,
  })
  expect(second.code).toBe(0)
  const session = await Bun.file(
    join(first.cwd, '.sessions/default.jsonl'),
  ).text()
  expect(session).toContain('第一句')
  expect(session).toContain('第二句')
})

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

// demo 模型按字符流式输出、每字 30ms（约 2 秒），在 CI 的慢机器上和其它并发用例一起会超过默认 5 秒
test.concurrent(
  'VELA_MODEL=mock still runs the keyword demo model offline',
  async () => {
    const { code, stdout } = await cli(['-p', '你好'], { model: 'mock' })
    expect(code).toBe(0)
    expect(stdout).toContain('Agent has completed its response')
  },
  20_000,
)

/** 交互模式：等到出现提示符再输入下一行，最后 exit */
async function repl(lines: string[], model: string) {
  const dir = tempDir('vela-repl-')
  dirs.push(dir)
  const proc = Bun.spawn(['bun', ENTRY], {
    cwd: dir.path,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
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
  return { stdout, code: await proc.exited, cwd: dir.path }
}

test.concurrent('interactive mode: a turn, a slash command, then exit', async () => {
  const { stdout, code, cwd } = await repl(
    ['你好', '/memory'],
    `faux:${scenario('hello')}`,
  )
  expect(code).toBe(0)
  expect(stdout).toContain('[Session] 新会话')
  expect(stdout).toContain('你好，我是 Vela（faux 回放）。')
  expect(stdout).toContain('[Token]')
  expect(stdout).toContain('[记忆系统] 共 0 条记忆')
  expect(stdout).toContain('Bye!')
  expect(await Bun.file(join(cwd, '.sessions/default.jsonl')).text()).toContain(
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
      HOME: process.env.HOME ?? '',
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
