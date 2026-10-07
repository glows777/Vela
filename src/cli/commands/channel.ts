import type { CommandHandler } from './index'

export const channelCommands: CommandHandler[] = [
  (cmd, { print, vela }) => {
    if (cmd !== '/channel' && cmd !== '/channel list') return false

    const channels = vela.channels()
    if (channels.length === 0) {
      print('\n[channels] 没有注册的通道。\n')
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
