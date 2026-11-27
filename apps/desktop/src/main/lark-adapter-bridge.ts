import type {
  ChannelAdapter,
  ChannelOutboundMessage,
  LocalVelaRuntime,
} from '@glows777/vela/legacy-desktop'
import type { Connection, Event } from '../shared/bridge.ts'

/** Bridges Lark ChannelAdapter inbound/outbound operations to desktop `history_changed` & `connection` events. */
export function wrapLarkAdapter(
  adapter: ChannelAdapter,
  runtime: LocalVelaRuntime,
  publish: (event: Event) => void,
): ChannelAdapter {
  let active = true
  let currentlyConnected = false
  let everConnected = false
  let sawFailureOrDisconnect = false
  let emittedInitialStatus = false

  const handleStatus = (state: Connection) => {
    if (!active) return
    emittedInitialStatus = true
    const shouldReset =
      state.connected &&
      !currentlyConnected &&
      (everConnected || sawFailureOrDisconnect)
    if (state.connected) {
      everConnected = true
    } else if (everConnected || state.error) {
      sawFailureOrDisconnect = true
    }
    currentlyConnected = state.connected
    try {
      publish({
        type: 'connection',
        channel: 'lark',
        value: state,
      })
      if (shouldReset) {
        publish({
          type: 'lark',
          channel: 'lark',
          value: { type: 'reset' },
        })
      }
    } catch (error) {
      console.warn('[desktop-lark] failed publishing connection event:', error)
    }
  }

  return {
    name: adapter.name,
    description: adapter.description,
    timezone: adapter.timezone,
    async start(ctx) {
      active = true
      emittedInitialStatus = false
      const wrappedCtx = {
        ...ctx,
        reportStatus: handleStatus,
        ingest: async (msg: Parameters<typeof ctx.ingest>[0]) => {
          await ctx.ingest(msg)
          if (!active) return
          try {
            publish({
              type: 'lark',
              channel: 'lark',
              value: { type: 'history_changed', chatId: msg.externalChatId },
            })
          } catch (error) {
            console.warn(
              '[desktop-lark] failed publishing history_changed after ingest:',
              error,
            )
          }
        },
        ...(ctx.ingestWithReceipt
          ? {
              ingestWithReceipt: async (
                msg: Parameters<NonNullable<typeof ctx.ingestWithReceipt>>[0],
              ) => {
                const receipt = await ctx.ingestWithReceipt!(msg)
                if (active && receipt.admitted) {
                  try {
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
                  } catch (error) {
                    console.warn(
                      '[desktop-lark] failed publishing history_changed after receipt:',
                      error,
                    )
                  }
                }
                return receipt
              },
            }
          : {}),
      }
      await adapter.start(wrappedCtx)
      if (!emittedInitialStatus && active) {
        handleStatus(adapter.status?.() ?? { connected: false })
      }
    },
    async stop() {
      active = false
      try {
        await adapter.stop()
      } finally {
        currentlyConnected = false
        try {
          publish({
            type: 'connection',
            channel: 'lark',
            value: { connected: false },
          })
        } catch (error) {
          console.warn(
            '[desktop-lark] failed publishing disconnect event on stop:',
            error,
          )
        }
      }
    },
    async deliver(message: ChannelOutboundMessage) {
      const result = await adapter.deliver(message)
      if (!active) return result
      try {
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
      } catch (error) {
        console.warn(
          '[desktop-lark] failed publishing history_changed after deliver:',
          error,
        )
      }
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
