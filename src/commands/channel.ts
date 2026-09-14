import type { ChannelGateway } from '../channels/gateway'
import type { CommandHandler } from './index'

export function createChannelCommands(
  gateway: ChannelGateway,
): CommandHandler[] {
  return [
    (cmd, _ctx) => {
      if (cmd !== '/channel' && cmd !== '/channel list') return false

      const channels = gateway.list()
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
}
