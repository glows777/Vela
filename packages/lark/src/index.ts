import type { ChannelExtension as VelaExtension } from '@glows777/vela-channels'
import type { ExtensionConfigDefinition } from '@glows777/vela-core/extension-api'
import { configString, configStrings } from '@glows777/vela-core/extension-api'
import { LarkChannel } from './channel.ts'
import type { LarkChat } from './chats.ts'
import { assertLarkEnv, assertLarkState } from './legacy.ts'
import type { LarkTransport } from './transport.ts'

export interface LarkOptions {
  appId?: string
  appSecret?: string
  /**
   * open_ids whose direct chats are always enabled. This does not enable their group chats.
   */
  owners?: string[]
  /** Enabled chat_ids. Every member has full access; the group and each topic have separate sessions. */
  chats?: (string | LarkChat)[]
  /** The connection to Lark; default lark's long connection with appId / appSecret (tests pass a fake) */
  transport?: LarkTransport
}

/** Lark bot channel (long-connection mode), one shared session per enabled chat and topic. Options not passed are read from the config section (`extensionConfig.lark`). */
export function lark(options: LarkOptions = {}): VelaExtension {
  return function lark(vela) {
    assertLarkState(vela.dataDir)
    const channel = new LarkChannel({
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

export const larkConfig: ExtensionConfigDefinition = {
  name: 'lark',
  resolve(section, context) {
    assertLarkEnv(context.env)
    return {
      appId: context.env.LARK_APP_ID,
      appSecret: context.env.LARK_APP_SECRET,
      owners: context.env.LARK_OWNERS,
      ...section,
    }
  },
}

export type {
  LarkCard,
  LarkCardAction,
  LarkCardResponse,
} from './cards.ts'
export type {
  LarkHistoryMessage,
  LarkMessageEvent,
  LarkSentMessage,
  LarkTransport,
} from './transport.ts'
