import type { DemoModel } from '../../testing/demo-model.ts'
import type { CommandHandler } from './index.ts'

export const debugCommands: CommandHandler[] = [
  (cmd, { print, vela }) => {
    const on = cmd === '/cache on'
    const off = cmd === '/cache off'
    if (!on && !off) return false
    const model = vela.model as Partial<DemoModel>
    if (typeof model.setCacheEnabled !== 'function') {
      print(
        '\n  Cache simulation only works with the demo model (VELA_MODEL=mock)\n',
      )
      return true
    }
    model.setCacheEnabled(on)
    print(on ? '\n  Cache simulation on\n' : '\n  Cache simulation off\n')
    return true
  },
]
