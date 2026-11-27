import type {
  ChannelAdapter,
  ChannelOutboundMessage,
  LocalVelaRuntime,
} from '@glows777/vela/legacy-desktop'
import type { Event } from '../shared/bridge.ts'

/** Bridges Lark ChannelAdapter inbound/outbound operations to desktop `history_changed` & `connection` events. */
export function wrapLarkAdapter(
  adapter: ChannelAdapter,
  runtime: LocalVelaRuntime,
  publish: (event: Event) => void,
): ChannelAdapter {
  return {
    name: adapter.name,
    description: adapter.description,
    timezone: adapter.timezone,
    async start(ctx) {
      const wrappedCtx = {
        ...ctx,
        ingest: async (msg: Parameters<typeof ctx.ingest>[0]) => {
          await ctx.ingest(msg)
          publish({
            type: 'lark',
            channel: 'lark',
            value: { type: 'history_changed', chatId: msg.externalChatId },
          })
        },
        ...(ctx.ingestWithReceipt
          ? {
              ingestWithReceipt: async (
                msg: Parameters<NonNullable<typeof ctx.ingestWithReceipt>>[0],
              ) => {
                const receipt = await ctx.ingestWithReceipt!(msg)
                if (receipt.admitted) {
                  publish({
                    type: 'lark',
                    channel: 'lark',
                    value: {
                      type: 'history_changed',
                      chatId: msg.externalChatId,
                      ...(msg.threadId && receipt.sessionId
                        ? { sessionId: receipt.sessionId }
                        : {}),
                    },
                  })
                }
                return receipt
              },
            }
          : {}),
      }
      await adapter.start(wrappedCtx)
      publish({
        type: 'connection',
        channel: 'lark',
        value: adapter.status?.() ?? { connected: false },
      })
    },
    async stop() {
      await adapter.stop()
      publish({
        type: 'connection',
        channel: 'lark',
        value: { connected: false },
      })
    },
    async deliver(message: ChannelOutboundMessage) {
      const result = await adapter.deliver(message)
      let sessionId: string | undefined
      if (message.threadId) {
        const bindings = await runtime.bindings.list({ channel: 'lark' })
        sessionId =
          bindings.find(
            (b) =>
              b.externalId === message.externalChatId &&
              b.threadId === message.threadId,
          )?.sessionId ?? undefined
      }
      publish({
        type: 'lark',
        channel: 'lark',
        value: {
          type: 'history_changed',
          chatId: message.externalChatId,
          ...(sessionId ? { sessionId } : {}),
        },
      })
      return result
    },
    ...(adapter.onDeliverySettled
      ? { onDeliverySettled: (info) => adapter.onDeliverySettled!(info) }
      : {}),
    ...(adapter.fetchAttachment
      ? {
          fetchAttachment: (ref, signal) =>
            adapter.fetchAttachment!(ref, signal),
        }
      : {}),
    ...(adapter.status ? { status: () => adapter.status!() } : {}),
    ...(adapter.listMessages
      ? { listMessages: (input) => adapter.listMessages!(input) }
      : {}),
    ...(adapter.listChats ? { listChats: () => adapter.listChats!() } : {}),
    ...(adapter.submitFromHost
      ? { submitFromHost: (input) => adapter.submitFromHost!(input) }
      : {}),
    ...(adapter.announce
      ? { announce: (input) => adapter.announce!(input) }
      : {}),
    ...(adapter.getTools
      ? { getTools: (binding) => adapter.getTools!(binding) }
      : {}),
  }
}
