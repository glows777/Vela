/**
 * registerChannel (Vela-specific): bring outside messages into Vela, one session per
 * conversation and sender, and send the replies back.
 * roleFor decides each sender's role. Without it every sender is a guest (no file reads or
 * writes, no commands, no access to the owner's memory).
 * This example sends and receives in memory instead of over a real IM connection;
 * `receive()` simulates an incoming message.
 */
import type { IncomingMessage, OutgoingMessage, VelaExtension } from '@glows777/vela'

export function echoChannel(options: { owners?: string[] } = {}) {
  let handler: ((msg: IncomingMessage) => void) | undefined
  const sent: OutgoingMessage[] = []

  const extension: VelaExtension = (vela) => {
    vela.registerChannel({
      name: 'echo',
      description: 'In-memory demo channel',
      start: () => {},
      stop: () => {},
      send: async (message) => {
        sent.push(message)
      },
      onMessage: (h) => {
        handler = h
      },
      roleFor: (msg) =>
        options.owners?.includes(msg.senderId) ? 'owner' : 'guest',
    })
  }

  return {
    extension,
    sent,
    receive: (senderId: string, text: string) =>
      handler?.({ channelId: 'demo', senderId, senderName: senderId, text }),
  }
}
