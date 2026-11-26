import type { CommandHandler } from './handler.ts'

export const debugCommands: CommandHandler[] = [
  (cmd, { runtime, session, print }) => {
    const on = cmd === '/cache on'
    const off = cmd === '/cache off'
    if (!on && !off) return false
    return (async () => {
      const res = await runtime.sessions.runCommand(session.id, cmd)
      if (!res.handled) {
        print(
          '\n  Cache simulation only works with the demo model (VELA_MODEL=mock)\n',
        )
      }
    })()
  },
]
