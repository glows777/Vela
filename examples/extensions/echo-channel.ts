/**
 * registerChannel（Vela 特有）：把外部消息接进 Vela，每个发送者一个会话，回复发回去。
 * roleFor 决定发送者的角色；不实现时一律 guest（不能读写文件、跑命令、看主人的记忆）。
 * 这里用内存里的收发代替真实的 IM 连接，`receive()` 模拟收到一条消息。
 */
import type { IncomingMessage, OutgoingMessage, VelaExtension } from 'vela'

export function echoChannel(options: { owners?: string[] } = {}) {
  let handler: ((msg: IncomingMessage) => void) | undefined
  const sent: OutgoingMessage[] = []

  const extension: VelaExtension = (vela) => {
    vela.registerChannel({
      name: 'echo',
      description: '内存里的演示通道',
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
