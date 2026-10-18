import type { SessionOptions, VelaSession } from '../vela-session.ts'
import type {
  ChannelDefinition,
  ChannelTopic,
  IncomingMessage,
} from './types.ts'

/** Admission runs inside the gateway's per-session queue; the directory is process-local. */
export class TopicAdmission {
  /** A reopened session is a new object and must be resumed again. */
  readonly resumed = new WeakSet<VelaSession>()
  private topics = new Map<
    string,
    { channel: string; chatId: string; topic: Omit<ChannelTopic, 'state'> }
  >()

  constructor(
    private open: (id: string, options?: SessionOptions) => VelaSession,
  ) {}

  async admit(
    id: string,
    channel: ChannelDefinition | undefined,
    msg: IncomingMessage,
  ): Promise<VelaSession | undefined> {
    const session = this.open(id, channel?.sessionOptions?.(msg))
    const exists = this.resumed.has(session)
      ? session.getEntries().length > 0
      : await session.resume()
    if (msg.requireExistingSession && !exists) {
      await session.close()
      return
    }
    this.resumed.add(session)
    msg.isNewTopic = !exists
    return session
  }

  observe(
    id: string,
    channel: string,
    msg: IncomingMessage,
    task = msg.text,
  ): void {
    if (msg.topic && !this.topics.has(id))
      this.topics.set(id, {
        channel,
        chatId: msg.channelId,
        topic: { ...msg.topic, task: task.slice(0, 120) },
      })
  }

  list(
    channel: string,
    chatId: string,
    state: (id: string) => ChannelTopic['state'],
  ): ChannelTopic[] {
    return [...this.topics.entries()]
      .filter(([, item]) => item.channel === channel && item.chatId === chatId)
      .map(([id, item]) => ({ ...item.topic, state: state(id) }))
  }
}
