import type { CommandHandler } from './index.ts'

export const channelCommands: CommandHandler[] = [
  (cmd, { print, runtime }) => {
    if (cmd !== '/channel' && cmd !== '/channel list') return false
    return (async () => {
      const bindings = await runtime.bindings.list()
      if (bindings.length === 0) {
        print('\n[channels] No channels configured.\n')
        return
      }
      print('\n[channels]')
      for (const b of bindings) {
        const target = b.threadId
          ? `${b.externalId}#${b.threadId}`
          : b.externalId
        const state = b.enabled ? 'enabled' : 'disabled'
        print(`  [${b.channel}] ${target} — ${state}`)
      }
      print('')
    })()
  },
]
