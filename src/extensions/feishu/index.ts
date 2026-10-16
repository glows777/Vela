import type { VelaExtension } from '../../index.ts'
import { configString, configStrings } from '../config.ts'
import { FeishuChannel, type FeishuTransport } from './channel.ts'

export interface FeishuOptions {
  appId?: string
  appSecret?: string
  /**
   * open_ids whose direct chats are always enabled. This does not enable their group chats.
   */
  owners?: string[]
  /** Enabled chat_ids. Every member has owner access to this machine and shares one session. */
  chats?: string[]
  /** The connection to Feishu; default lark's long connection with appId / appSecret (tests pass a fake) */
  transport?: FeishuTransport
}

/** Feishu bot channel (long-connection mode), one shared owner session per enabled chat. Options not passed are read from the config section (`extensionConfig.feishu`). */
export function feishu(options: FeishuOptions = {}): VelaExtension {
  return function feishu(vela) {
    vela.registerChannel(
      new FeishuChannel({
        appId: options.appId ?? configString(vela.config, 'appId') ?? '',
        appSecret:
          options.appSecret ?? configString(vela.config, 'appSecret') ?? '',
        owners: options.owners ?? configStrings(vela.config, 'owners') ?? [],
        chats: options.chats ?? configStrings(vela.config, 'chats') ?? [],
        logger: vela.logger,
        transport: options.transport,
      }),
    )
  }
}
