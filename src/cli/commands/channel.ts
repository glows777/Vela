import type { CommandHandler } from './index'

export const channelCommands: CommandHandler[] = [
  (cmd, { vela }) => {
    if (cmd !== '/channel' && cmd !== '/channel list') return false

    const channels = vela.channels()
    if (channels.length === 0) {
      console.log('\n[channels] 没有注册的通道。\n')
      return true
    }

    console.log('\n[channels]')
    for (const ch of channels) {
      console.log(`  ${ch.name} — ${ch.description}`)
    }
    console.log('')
    return true
  },
]
