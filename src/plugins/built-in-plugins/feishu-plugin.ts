import { FeishuChannel } from '../../channels/built-in-channels/lark'
import type { PluginDefinition } from '../types'

export const feishuPlugin: PluginDefinition = {
  name: 'feishu',
  version: '1.0.0',
  description: '注册飞书 Bot 消息通道',
  config: {
    appId: '${FEISHU_APP_ID}',
    appSecret: '${FEISHU_APP_SECRET}',
    port: '${FEISHU_PORT}',
  },

  activate(api) {
    const config = api.getConfig()
    api.registerChannel(
      new FeishuChannel({
        appId: String(config.appId || ''),
        appSecret: String(config.appSecret || ''),
        port: Number(config.port || '3000'),
      }),
    )
  },
}
