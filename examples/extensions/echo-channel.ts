/**
 * registerChannel (Vela-specific): bring outside messages into Vela, one session per
 * conversation, and send the replies back.
 * This example sends and receives in memory instead of over a real IM connection;
 * `receive()` simulates an incoming message.
 */
import type {
  IncomingMessage,
  OutgoingMessage,
  VelaExtension,
} from '@glows777/vela'

export function echoChannel() {
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
    })
  }

  return {
    extension,
    sent,
    receive: (senderId: string, text: string) =>
      handler?.({ channelId: 'demo', senderId, senderName: senderId, text }),
  }
}
