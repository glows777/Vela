import { estimateMessageTokens } from '../../context/defense.ts'
import { createRequestSnapshot } from '../../context/request.ts'
import { textToolResultOutput } from '../../context/tool-result-output.ts'
import type { DemoModel } from '../../testing/demo-model.ts'
import type { CommandHandler } from './index.ts'

export const debugCommands: CommandHandler[] = [
  (cmd, { print, session }) => {
    if (cmd !== 'sim') return false
    const now = Date.now()
    print('\n[sim] Injecting 20 history messages (with large tool results)...')
    for (let i = 0; i < 5; i++) {
      const age = (20 - i * 4) * 60 * 1000
      const idx = session.messages.length
      session.messages.push({
        role: 'user',
        content: `Turn ${i + 1}: read file-${i}.ts for me`,
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
          { type: 'text' as const, text: `Read the contents of file-${i}.ts.` },
        ],
      })
      session.timestamps.set(session.messages[idx + 3]!, now - age)
    }
    print(
      `[sim done] ${session.messages.length} messages, ~${estimateMessageTokens(session.messages)} tokens\n`,
    )
    return true
  },

  (cmd, { print, session }) => {
    if (cmd !== 'defend') return false
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
        print(`[Defense] Cleanup not applied: ${error instanceof Error ? error.message : error}`)
      } finally {
        busy.locked = false
        busy.controller = undefined
      }
    })()
  },

  (cmd, { print, session }) => {
    if (cmd !== 'status') return false
    const tokens = estimateMessageTokens(session.messages)
    print(
      `\n[status] ${session.messages.length} messages, ~${tokens} tokens\n`,
    )
    return true
  },

  (cmd, { print, vela }) => {
    const on = cmd === '/cache on' || cmd === 'cache on'
    const off = cmd === '/cache off' || cmd === 'cache off'
    if (!on && !off) return false
    const model = vela.model as Partial<DemoModel>
    if (typeof model.setCacheEnabled !== 'function') {
      print('\n  Cache simulation only works with the demo model (VELA_MODEL=mock)\n')
      return true
    }
    model.setCacheEnabled(on)
    print(on ? '\n  Cache simulation on\n' : '\n  Cache simulation off\n')
    return true
  },
]
