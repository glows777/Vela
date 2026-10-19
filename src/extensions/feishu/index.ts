import type { VelaExtension } from '../../index.ts'
import { configString, configStrings } from '../config.ts'
import { FeishuChannel } from './channel.ts'
import type { FeishuChat } from './chats.ts'
import type { FeishuTransport } from './transport.ts'

export interface FeishuOptions {
  appId?: string
  appSecret?: string
  /**
   * open_ids whose direct chats are always enabled. This does not enable their group chats.
   */
  owners?: string[]
  /** Enabled chat_ids. Every member has owner access; the group and each topic have separate sessions. */
  chats?: (string | FeishuChat)[]
  /** The connection to Feishu; default lark's long connection with appId / appSecret (tests pass a fake) */
  transport?: FeishuTransport
}

/** Feishu bot channel (long-connection mode), an owner session per enabled chat and topic. Options not passed are read from the config section (`extensionConfig.feishu`). */
export function feishu(options: FeishuOptions = {}): VelaExtension {
  return function feishu(vela) {
    const channel = new FeishuChannel({
      appId: options.appId ?? configString(vela.config, 'appId') ?? '',
      appSecret:
        options.appSecret ?? configString(vela.config, 'appSecret') ?? '',
      owners: options.owners ?? configStrings(vela.config, 'owners') ?? [],
      chats: options.chats ?? vela.config.chats,
      logger: vela.logger,
      dataDir: vela.dataDir,
      transport: options.transport,
      timezone: vela.config.timezone,
    })
    vela.registerChannel(channel)
    channel.topics.register(vela)
  }
}
