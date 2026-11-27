import type { CommandHandler } from './index.ts'

export const channelCommands: CommandHandler[] = [
  (cmd, { print, runtime }) => {
    if (cmd !== '/channel' && cmd !== '/channel list') return false
    return (async () => {
      const [channels, bindings] = await Promise.all([
        runtime.channels.list(),
        runtime.bindings.list(),
      ])
      if (channels.length === 0 && bindings.length === 0) {
        print('\n[channels] No channels configured.\n')
        return
      }
      print('\n[channels]')
      for (const ch of channels) {
        const state = ch.connected
          ? 'connected'
          : ch.enabled
            ? 'disconnected'
            : 'disabled'
        const detail = ch.error ? ` (${ch.error})` : ''
        print(`  adapter ${ch.name} — ${state}${detail}`)
      }
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
