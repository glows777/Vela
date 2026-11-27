import type { ExtensionConfigDefinition } from '../extension-api.ts'

export const larkConfig: ExtensionConfigDefinition = {
  name: 'lark',
  resolve(section, context) {
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
export {
  type LarkChat,
  larkChatBindingConfig,
  parseChats,
  validateChatTools,
} from './chats.ts'
export {
  createLarkChannelAdapter,
  LarkChannelAdapter,
  type LarkChannelAdapterOptions,
} from './runtime-adapter.ts'
export { connectLarkSetup, discoverLarkGroup } from './setup.ts'
export type {
  LarkHistoryMessage,
  LarkMessageEvent,
  LarkSentMessage,
  LarkTransport,
} from './transport.ts'
