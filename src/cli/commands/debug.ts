import { estimateMessageTokens } from '../../context/defense.ts'
import { createRequestSnapshot } from '../../context/request.ts'
import { textToolResultOutput } from '../../context/tool-result-output.ts'
import type { DemoModel } from '../../testing/demo-model.ts'
import type { CommandHandler } from './index.ts'

export const debugCommands: CommandHandler[] = [
  (cmd, { print, session }) => {
    if (cmd !== '模拟长对话' && cmd !== 'sim') return false
    const now = Date.now()
    print('\n[模拟] 注入 20 条历史消息（含大量工具结果）...')
    for (let i = 0; i < 5; i++) {
      const age = (20 - i * 4) * 60 * 1000
      const idx = session.messages.length
      session.messages.push({
        role: 'user',
        content: `第 ${i + 1} 轮：帮我读文件 file-${i}.ts`,
      })
      session.timestamps.set(session.messages[idx]!, now - age)
      session.messages.push({
        role: 'assistant',
        content: [
          {
            type: 'tool-call' as const,
            toolCallId: `sim-${i}`,
            toolName: 'read_file',
            input: { path: `file-${i}.ts` },
          },
        ],
      })
      session.timestamps.set(session.messages[idx + 1]!, now - age)
      const bigContent =
        `// file-${i}.ts\n` +
        'export function handler() {\n  // ...\n}\n'.repeat(200)
      session.messages.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result' as const,
            toolCallId: `sim-${i}`,
            toolName: 'read_file',
            output: textToolResultOutput(bigContent),
          },
        ],
      })
      session.timestamps.set(session.messages[idx + 2]!, now - age)
      session.messages.push({
        role: 'assistant',
        content: [
          { type: 'text' as const, text: `文件 file-${i}.ts 的内容已读取。` },
        ],
      })
      session.timestamps.set(session.messages[idx + 3]!, now - age)
    }
    print(
      `[模拟完成] ${session.messages.length} 条消息, ~${estimateMessageTokens(session.messages)} tokens\n`,
    )
    return true
  },

  (cmd, { print, session }) => {
    if (cmd !== '执行防线' && cmd !== 'defend') return false
    const busy = session.busy
    if (busy.locked) return true
    busy.locked = true
    const controller = new AbortController()
    busy.controller = controller
    return (async () => {
      try {
        const request = await createRequestSnapshot(
          session.model,
          session.buildSystem(),
          session.registry.toAISDKFormat(),
          session.messages,
          controller.signal,
        )
        await session.prepareContext(request, { allowSummary: false })
        await session.save()
      } catch (error) {
        print(`[Defense] 未应用清理: ${error instanceof Error ? error.message : error}`)
      } finally {
        busy.locked = false
        busy.controller = undefined
      }
    })()
  },

  (cmd, { print, session }) => {
    if (cmd !== 'status' && cmd !== '查看状态') return false
    const tokens = estimateMessageTokens(session.messages)
    print(
      `\n[状态] ${session.messages.length} 条消息, ~${tokens} tokens\n`,
    )
    return true
  },

  (cmd, { print, vela }) => {
    const on = cmd === '/cache on' || cmd === 'cache on'
    const off = cmd === '/cache off' || cmd === 'cache off'
    if (!on && !off) return false
    const model = vela.model as Partial<DemoModel>
    if (typeof model.setCacheEnabled !== 'function') {
      print('\n  cache 模拟只对 VELA_MODEL=mock 的 demo 模型有效\n')
      return true
    }
    model.setCacheEnabled(on)
    print(on ? '\n  已开启 cache 模拟\n' : '\n  已关闭 cache 模拟\n')
    return true
  },
]
