export { local } from './local.ts'
export type {
  LocalEvent,
  LocalEventData,
  LocalHost,
  LocalMessage,
  LocalOptions,
  LocalProgress,
  LocalProject,
  LocalSession,
} from './local-protocol.ts'
export { LocalError } from './local-protocol.ts'
export { routineToolSchema } from './routines.ts'
export type { ChannelScope } from './scope.ts'
export { chatDirectory, groupWorkspace } from './scope.ts'
export { channelSessionId } from './session-id.ts'
export {
  handoffToolNames,
  topicSessionOptions,
  topicToolNames,
} from './topics.ts'
export type * from './types.ts'
export type {
  ChannelExtension,
  ChannelExtensionAPI,
  ChannelVela,
  ChannelVelaOptions,
  LoadedChannelExtension,
} from './vela.ts'
export { createChannelVela } from './vela.ts'
