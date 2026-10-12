import type { VelaExtension } from '../../index.ts'
import { configString, configStrings } from '../config.ts'
import { FeishuChannel, type FeishuTransport } from './channel.ts'

export interface FeishuOptions {
  appId?: string
  appSecret?: string
  /**
   * open_ids of senders who get the owner role. All other senders are guests: no file reads or
   * writes, no commands, and no access to the owner's memory.
   */
  owners?: string[]
  /** The connection to Feishu; default lark's long connection with appId / appSecret (tests pass a fake) */
  transport?: FeishuTransport
}

/** Feishu bot channel (long-connection mode), one session per chat and sender. Options not passed are read from the config section (`extensionConfig.feishu`). */
export function feishu(options: FeishuOptions = {}): VelaExtension {
  return function feishu(vela) {
    vela.registerChannel(
      new FeishuChannel({
        appId: options.appId ?? configString(vela.config, 'appId') ?? '',
        appSecret:
          options.appSecret ?? configString(vela.config, 'appSecret') ?? '',
        owners: options.owners ?? configStrings(vela.config, 'owners') ?? [],
        logger: vela.logger,
        transport: options.transport,
      }),
    )
  }
}
