import type { VelaExtension } from '../../index.ts'
import { configString, configStrings } from '../config.ts'
import { FeishuChannel } from './channel.ts'

export interface FeishuOptions {
  appId?: string
  appSecret?: string
  /**
   * 拿到 owner 角色的发送者 open_id。其余发送者是 guest：不能读写文件、跑命令，
   * 也看不到主人的记忆。
   */
  owners?: string[]
}

/** 飞书 Bot 通道（长连接模式）：每个发送者一个会话。没传的选项从配置段（`extensionConfig.feishu`）取。 */
export function feishu(options: FeishuOptions = {}): VelaExtension {
  return function feishu(vela) {
    vela.registerChannel(
      new FeishuChannel({
        appId: options.appId ?? configString(vela.config, 'appId') ?? '',
        appSecret:
          options.appSecret ?? configString(vela.config, 'appSecret') ?? '',
        owners: options.owners ?? configStrings(vela.config, 'owners') ?? [],
        logger: vela.logger,
      }),
    )
  }
}
