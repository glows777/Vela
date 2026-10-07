import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
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
    /** 在伪终端里运行（交互模式）：屏幕上出现第一项后，输入第二项（按顺序） */
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

/** 数据目录里保存的会话文件（每次启动一个新会话，id 是时间 + 随机数） */
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
  const { stdout, code, dataDir } = await cli(['-p', '你好'], {
    model: `faux:${scenario('hello')}`,
  })
  expect(code).toBe(0)
  // 同 pi：stdout 只有最后的回答，诊断信息在 stderr
  expect(stdout).toBe('你好，我是 Vela（faux 回放）。\n')
  const files = sessionFiles(dataDir)
  expect(files).toHaveLength(1)
  expect(files[0]).toMatch(/\/\d{8}-\d{6}-[0-9a-f]{4}\.jsonl$/)
  expect(await Bun.file(files[0]!).text()).toContain('faux 回放')
})

test.concurrent('-p executes tools from the scenario in the process working directory', async () => {
  const { stdout, code } = await cli(['-p', '看看 notes.txt'], {
    model: `faux:${scenario('read-file')}`,
    files: { 'notes.txt': 'remember the milk' },
  })
  expect(code).toBe(0)
  expect(stdout).toBe('notes.txt 里写着 remember the milk\n')
})

test.concurrent('piped stdin is prepended to the prompt (print mode without -p)', async () => {
  const { stdout, code, dataDir } = await cli(['总结一下'], {
    model: `faux:${scenario('hello')}`,
    stdin: '一些管道输入',
  })
  expect(code).toBe(0)
  expect(stdout).toBe('你好，我是 Vela（faux 回放）。\n')
  const saved = await Bun.file(sessionFiles(dataDir)[0]!).text()
  expect(saved).toContain('一些管道输入\\n\\n总结一下')
})

test.concurrent('--mode json writes a session header and one JSON event per line', async () => {
  const { stdout, code } = await cli(['--mode', 'json', '看看 notes.txt'], {
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

// 两次冷启动 CLI；CI 上和其它并发用例一起，每次 2-3 秒，会超过默认 5 秒
test.concurrent('each run starts a new session; -c continues the most recent one', async () => {
  const first = await cli(['-p', '第一句'], {
    model: `faux:${scenario('hello')}`,
  })
  const second = await cli(['-p', '第二句'], {
    model: `faux:${scenario('hello')}`,
    cwd: first.cwd,
    agentDir: first.agentDir,
  })
  const third = await cli(['-p', '第三句', '-c'], {
    model: `faux:${scenario('hello')}`,
    cwd: first.cwd,
    agentDir: first.agentDir,
  })
  expect(third.code).toBe(0)
  const files = sessionFiles(first.dataDir)
  expect(files).toHaveLength(2)
  const contents = await Promise.all(files.map((f) => Bun.file(f).text()))
  expect(contents.some((c) => c.includes('第一句') && !c.includes('第二句'))).toBe(true)
  expect(contents.some((c) => c.includes('第二句') && c.includes('第三句'))).toBe(true)
  expect(second.code).toBe(0)
  // 三次启动 CLI 子进程，和其它并发用例一起时默认 5 秒不够
}, 20_000)

test.concurrent('-c -p with a command prints nothing on stdout, not the previous answer', async () => {
  const first = await cli(['-p', '你好'], { model: `faux:${scenario('hello')}` })
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
  // 上一次的回答在恢复的历史里，但不是这次产生的
  expect(second.stdout).toBe('')
}, 20_000)

test.concurrent('--session opens a named session id; -r needs interactive mode', async () => {
  const first = await cli(['-p', '你好', '--session', 'work'], {
    model: `faux:${scenario('hello')}`,
  })
  expect(first.code).toBe(0)
  expect(sessionFiles(first.dataDir).map((f) => f.split('/').at(-1))).toEqual([
    'work.jsonl',
  ])
  const resume = await cli(['-p', '你好', '-r'], {
    model: `faux:${scenario('hello')}`,
  })
  expect(resume.code).toBe(2)
  expect(resume.stderr).toContain('-r 只能在交互模式用')
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
  expect(stderr).toContain('没有 prompt')
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
  const { stderr, code } = await cli(['-p', '你好'], {
    model: `faux:${scenario('hello')}`,
    agentDir: home.path,
    env: { GREET_TOKEN: 't0k' },
  })
  expect(code).toBe(0)
  expect(stderr).toContain('[greet] loaded {"token":"t0k"}')
})

test.concurrent('project extensions load only when the project is trusted', async () => {
  const files = { '.vela/extensions/local.ts': GREET('local') }
  const skipped = await cli(['-p', '你好'], {
    model: `faux:${scenario('hello')}`,
    files,
  })
  expect(skipped.code).toBe(0)
  expect(skipped.stderr).not.toContain('[local] loaded')
  expect(skipped.stderr).toContain('[信任] 没有加载')

  const approved = await cli(['-p', '你好', '--approve'], {
    model: `faux:${scenario('hello')}`,
    files,
  })
  expect(approved.code).toBe(0)
  expect(approved.stderr).toContain('[local] loaded')
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
  expect(saved.stderr).toContain('[local] loaded')
}, 20_000)

test.concurrent('-e loads an extension file; --no-extensions drops built-in and discovered ones', async () => {
  const dir = tempDir('vela-ext-')
  dirs.push(dir)
  const extra = join(dir.path, 'extra.ts')
  await Bun.write(extra, GREET('extra'))
  const { stderr, code } = await cli(
    ['-p', '你好', '--no-extensions', '-e', extra],
    { model: `faux:${scenario('hello')}` },
  )
  expect(code).toBe(0)
  expect(stderr).toContain('[extra] loaded {}')
  // supabase 内置扩展没加载（它加载时会提示 Mock 模式）
  expect(stderr).not.toContain('[supabase]')
})

test.concurrent('--no-session keeps the session in memory', async () => {
  const { code, dataDir } = await cli(['-p', '你好', '--no-session'], {
    model: `faux:${scenario('hello')}`,
  })
  expect(code).toBe(0)
  expect(sessionFiles(dataDir)).toEqual([])
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
  expect(stdout.trim()).not.toBe('')
}, 20_000)

// 交互模式（TUI）只在终端里出现（管道输入走单次模式，同 pi）：用 util-linux 的 script 给子进程一个伪终端。
// TUI 本身的行为在 e2e/tui 里用假终端测，这里只确认真实终端里能启动、对话、退出
const hasScript =
  process.platform === 'linux' && Bun.spawnSync(['script', '-V']).exitCode === 0

test.if(hasScript)(
  'interactive mode in a real terminal: a turn, then Ctrl+D exits and the session is saved',
  async () => {
    const { stdout, code, dataDir } = await cli([], {
      model: `faux:${scenario('hello')}`,
      terminal: [
        ['Ctrl+D 退出', '你好\r'],
        ['你好，我是 Vela（faux 回放）。', '\x04'],
      ],
    })
    expect(code).toBe(0)
    expect(stdout).toContain('你好，我是 Vela（faux 回放）。')
    const files = sessionFiles(dataDir)
    expect(files).toHaveLength(1)
    expect(await Bun.file(files[0]!).text()).toContain('你好')
  },
)

test.if(hasScript)(
  '-r lists saved sessions and resumes the chosen one',
  async () => {
    const first = await cli(['-p', '你好'], {
      model: `faux:${scenario('hello')}`,
    })
    expect(first.code).toBe(0)
    const picked = await cli(['-r'], {
      model: `faux:${scenario('hello')}`,
      cwd: first.cwd,
      agentDir: first.agentDir,
      terminal: [
        ['选择要恢复的会话', '\r'],
        ['恢复会话', '\x04'],
      ],
    })
    expect(picked.code).toBe(0)
    // 恢复的历史画出来了；恢复的是同一个会话，没有另存一个新的
    expect(picked.stdout).toContain('你好，我是 Vela（faux 回放）。')
    expect(sessionFiles(first.dataDir)).toHaveLength(1)
  },
)

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
  expect(first.stderr).not.toContain('[模型]')
  expect(first.code).toBe(0)
  expect(first.stdout).toBe('来自 m high\n')

  // 没给 --model：恢复会话里保存的模型和 thinking，不需要 OPENAI_API_MODEL_NAME
  const second = await cli(['-p', '再来', '--continue'], {
    model: '',
    cwd: first.cwd,
    agentDir: home.path,
  })
  expect(second.stderr).not.toContain('[模型]')
  expect(second.code).toBe(0)
  expect(second.stdout).toContain('来自 m high')

  // VELA_MODEL=faux 回放时不被保存的模型覆盖
  const third = await cli(['-p', '你好', '--continue'], {
    model: `faux:${scenario('hello')}`,
    cwd: first.cwd,
    agentDir: home.path,
  })
  expect(third.code).toBe(0)
  expect(third.stdout).not.toContain('来自 m')
  // 三次启动 CLI 子进程
}, 20_000)

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
