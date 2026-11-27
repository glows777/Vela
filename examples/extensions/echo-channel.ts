/**
 * Runtime ChannelAdapter example: bring outside messages into Vela through `createRuntime()` +
 * `registerChannel()`, routing each external conversation to a session and delivering replies back.
 * This example sends and receives in memory instead of over a real IM connection;
 * `receive()` simulates an incoming message.
 */
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelOutboundMessage,
} from '@glows777/vela'

export function echoChannel(): {
  adapter: ChannelAdapter
  sent: ChannelOutboundMessage[]
  receive: (
    externalChatId: string,
    senderId: string,
    text: string,
  ) => Promise<void>
} {
  let ctx: ChannelAdapterContext | undefined
  let seq = 0
  const sent: ChannelOutboundMessage[] = []

  const adapter: ChannelAdapter = {
    name: 'echo',
    description: 'In-memory demo channel',
    async start(nextCtx) {
      ctx = nextCtx
    },
    async stop() {
      ctx = undefined
    },
    async deliver(message) {
      sent.push(message)
      return { externalMessageId: `echo-out-${++seq}` }
    },
  }

  return {
    adapter,
    sent,
    receive: async (externalChatId, senderId, text) => {
      if (!ctx) throw new Error('echo channel is not started')
      const id = `echo-in-${++seq}`
      await ctx.ingest({
        channel: 'echo',
        dedupeKey: `echo:${id}`,
        externalChatId,
        kind: 'group',
        messageId: id,
        senderId,
        senderName: senderId,
        text,
        mentioned: true,
        timestamp: new Date().toISOString(),
      })
    },
  }
}
