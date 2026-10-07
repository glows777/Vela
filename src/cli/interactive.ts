import { createInterface } from 'node:readline'
import {
  Client,
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/client'
import type { SessionUI } from '../extensions/types'
import { type Vela, velaInternals } from '../vela'
import type { VelaSession } from '../vela-session'
import type { CommandContext } from './commands'
import { createCliDispatcher } from './dispatcher'
import { printEvent } from './print-event'

/**
 * 交互模式（readline REPL）。第 2 步下半（2-2）换成 pi-tui 的 TUI（运行中 Enter = steer、Alt+Enter = followUp）。
 */
export async function runInteractive(options: {
  vela: Vela
  /** 启动时的会话；pick 时让用户从保存过的会话里选 */
  sessionId: string
  resume: boolean
  pick: boolean
  /** 会话打开（恢复）之后调用；返回模型是否可用 */
  configure: (session: VelaSession) => boolean
  onExit: () => Promise<void>
}): Promise<void> {
  const { vela, configure } = options
  const internals = velaInternals(vela)
  vela.subscribe((event) => printEvent(event))
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  let rlClosed = false
  // 自己排队输入行：管道输入会一次性读完，rl.question 注册前到达的行会丢失
  const pendingLines: string[] = []
  let lineWaiter: ((line: string | undefined) => void) | undefined
  rl.on('line', (line) => {
    const waiter = lineWaiter
    lineWaiter = undefined
    if (waiter) waiter(line)
    else pendingLines.push(line)
  })
  rl.on('close', () => {
    rlClosed = true
    lineWaiter?.(undefined)
    lineWaiter = undefined
    // 终端里 Ctrl+D 中断当前任务；管道输入读到 EOF 时让已排队的行照常跑完
    if (process.stdin.isTTY)
      session.abort(new DOMException('输入已关闭', 'AbortError'))
  })
  const nextLine = (): Promise<string | undefined> => {
    if (pendingLines.length) return Promise.resolve(pendingLines.shift())
    if (rlClosed) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      lineWaiter = resolve
    })
  }

  /** 交互模式下扩展的界面：在终端里提问，读下一行输入作为回答。 */
  const terminalUI: SessionUI = {
    notify: (message, level = 'info') =>
      console.log(
        level === 'info' ? `\n${message}` : `\n[${level}] ${message}`,
      ),
    async confirm(title, message) {
      console.log(`\n${title}\n${message}`)
      process.stdout.write('允许？(y/N) ')
      const answer = (await nextLine())?.trim().toLowerCase()
      return answer === 'y' || answer === 'yes'
    },
    async select(title, options) {
      console.log(`\n${title}`)
      for (const [i, option] of options.entries())
        console.log(`  ${i + 1}. ${option}`)
      process.stdout.write('选择编号（回车取消）: ')
      const index = Number((await nextLine())?.trim()) - 1
      return options[index]
    },
    async input(title, placeholder) {
      process.stdout.write(
        `\n${title}${placeholder ? ` (${placeholder})` : ''}: `,
      )
      const answer = (await nextLine())?.trim()
      return answer || undefined
    },
  }
  let sessionId = options.sessionId
  let resume = options.resume
  if (options.pick) {
    const saved = await vela.listSessions()
    const labels = saved.map(
      (s) =>
        `${s.name ?? s.firstMessage.slice(0, 40)}  (${s.id}，${s.messageCount} 条，${s.updatedAt})`,
    )
    const chosen = saved.length
      ? await terminalUI.select('选择要恢复的会话', labels)
      : undefined
    if (chosen !== undefined) {
      sessionId = (saved[labels.indexOf(chosen)] as { id: string }).id
      resume = true
    } else
      console.log(
        saved.length ? '没有选择，开新会话' : '没有保存过的会话，开新会话',
      )
  }
  const session = vela.session(sessionId, { ui: terminalUI })
  const { busy, messages } = session

  const MCP_INITIAL_RETRY_DELAY_MS = 30_000
  const MCP_MAX_RETRY_DELAY_MS = 5 * 60_000

  const mcpConnection: Promise<boolean> | null = null
  let mcpFailureCount = 0
  let nextMCPRetryAt = 0

  async function connectMCP() {
    // if (mcpConnection) {
    //   await mcpConnection;
    //   return;
    // }
    // if (Date.now() < nextMCPRetryAt) {
    //   return;
    // }
    // const connection = connectGitHubMCP();
    // mcpConnection = connection;
    // const connected = await connection;
    // if (connected) {
    //   mcpFailureCount = 0;
    //   nextMCPRetryAt = 0;
    // } else {
    //   if (mcpConnection === connection) {
    //     mcpConnection = null;
    //   }
    //   scheduleMCPRetry();
    // }
  }

  async function connectGitHubMCP(): Promise<boolean> {
    const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN

    if (!githubToken) {
      console.log('\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，使用 Mock MCP')
      return true
    }

    console.log('\n连接 GitHub MCP Server...')
    try {
      const transport = new StdioClientTransport({
        command: 'bunx',
        args: ['@modelcontextprotocol/server-github'],
        env: {
          ...getDefaultEnvironment(),
          GITHUB_PERSONAL_ACCESS_TOKEN: githubToken,
        },
      })
      const client = new Client({ name: 'Vela-agent', version: '1.0.0' })
      const tools = await internals.registry.registerMCPServer(
        'github',
        client,
        transport,
      )
      console.log(`  已注册 ${tools.length} 个 MCP 工具`)
      return true
    } catch (err) {
      console.log(`  MCP 连接失败: ${err instanceof Error ? err.message : err}`)
      console.log(err)
      return false
    }
  }

  function scheduleMCPRetry() {
    mcpFailureCount++
    const delay = Math.min(
      MCP_INITIAL_RETRY_DELAY_MS * 2 ** (mcpFailureCount - 1),
      MCP_MAX_RETRY_DELAY_MS,
    )
    nextMCPRetryAt = Date.now() + delay
    console.log(`  MCP 将在 ${Math.round(delay / 1000)} 秒后再次尝试连接`)
  }

  await connectMCP()

  const cancelOrClose = () => {
    // 正在跑 agent loop 或扩展命令（例如 /rag ingest）时取消它，空闲时退出
    const signal = session.signal
    if (signal) {
      if (!signal.aborted) {
        session.abort()
        console.log('\n[取消] 正在停止当前请求和工具…')
      }
    } else rl.close()
  }
  rl.on('SIGINT', cancelOrClose)
  process.on('SIGINT', cancelOrClose)

  const dispatch = createCliDispatcher(vela)

  if (resume && (await session.resume())) {
    console.log(
      `[Session] 恢复会话 ${session.id}，${messages.length} 条历史消息`,
    )
  } else {
    console.log(`[Session] 新会话 ${session.id}`)
  }

  // Persist the history identity before any tool side effects, including on legacy resume.
  await session.save()

  // 显示各 prompt 段落的状态
  console.log('\n=== Prompt PipeLine Debug ===')
  for (const { name, chars } of internals.builder.status({
    ...session.promptContext(),
    toolCount: internals.registry.getAllTools().length,
  }))
    console.log(
      `  ${name}: ${chars === null ? '[OFF]' : `[ON] ${chars} chars`}`,
    )
  console.log('========================\n')
  try {
    await vela.ready()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
  }
  if (configure(session))
    console.log(
      `  模型 ${session.modelInfo.ref}，thinking ${session.thinkingLevel}`,
    )
  else console.error('  用 /model provider/id 换一个模型')
  for (const ext of vela.extensions())
    console.log(
      `  ✓ 扩展 ${ext.name}${ext.tools.length ? ` — ${ext.tools.length} 个工具` : ''}`,
    )
  console.log('  启动 Channel...')
  await vela.startChannels()
  const ask = () => {
    if (rlClosed) process.stdout.write('You: ')
    else {
      rl.setPrompt('You: ')
      rl.prompt()
    }
    void nextLine().then(async (input) => {
      await connectMCP()

      const trimmed = (input ?? '').trim()
      if (!trimmed || trimmed === 'exit') {
        console.log('Bye!')
        await options.onExit()
        rl.close()
        return
      }

      const ctx: CommandContext = { vela, internals, session, ask }
      if (busy.locked) {
        console.log('\n[system] 有任务正在执行中，请稍候再输入\n')
        // 不调用 ask()：当前 agentLoop 的 .then/.catch 完成后会重新注册 question
        return
      }
      const handled = dispatch(trimmed, ctx)
      if (handled === 'async') return
      if (handled) {
        ask()
        return
      }

      // VELA_DEBUG=1 时打印每轮重新构建的 system prompt
      if (process.env.VELA_DEBUG === '1') console.log(session.buildSystem())

      try {
        await session.prompt(trimmed)
      } catch (error) {
        console.error(
          '[Agent] 本轮停止:',
          error instanceof Error ? error.message : error,
        )
      }

      const status = session.tracker.status
      console.log(`  [Token] ~${status.tokens} tokens (${status.percent}%)`)
      ask()
    })
  }

  ask()
}
