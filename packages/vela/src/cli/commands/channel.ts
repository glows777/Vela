import type { CommandHandler } from './index.ts'

export const channelCommands: CommandHandler[] = [
  (cmd, { print, vela }) => {
    if (cmd !== '/channel' && cmd !== '/channel list') return false

    const channels = vela.channels()
    if (channels.length === 0) {
      print('\n[channels] No channels registered.\n')
      return true
    }

    print('\n[channels]')
    for (const ch of channels) {
      print(`  ${ch.name} — ${ch.description}`)
    }
    print('')
    return true
  },
]
