import type { VelaExtension } from '../../index'
import { FeishuChannel } from './channel'

export interface FeishuOptions {
  appId?: string
  appSecret?: string
  /**
   * 拿到 owner 角色的发送者 open_id。其余发送者是 guest：不能读写文件、跑命令，
   * 也看不到主人的记忆。
   */
  owners?: string[]
}

/** 飞书 Bot 通道（长连接模式）：每个发送者一个会话。 */
export function feishu(options: FeishuOptions = {}): VelaExtension {
  return function feishu(vela) {
    vela.registerChannel(
      new FeishuChannel({
        appId: options.appId ?? '',
        appSecret: options.appSecret ?? '',
        owners: options.owners ?? [],
        logger: vela.logger,
      }),
    )
  }
}
