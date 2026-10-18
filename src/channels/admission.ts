import type { SessionOptions, VelaSession } from '../vela-session.ts'
import type { ChannelDirectory } from './directory.ts'
import type {
  ChannelDefinition,
  ChannelTopic,
  IncomingMessage,
} from './types.ts'

/** Admission runs inside the gateway's per-session queue; the directory is shared with recovery. */
export class TopicAdmission {
  /** A reopened session is a new object and must be resumed again. */
  readonly resumed = new WeakSet<VelaSession>()

  constructor(
    private directory: ChannelDirectory,
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
    this.directory.observe(id, channel, msg, task)
  }

  list(
    channel: string,
    chatId: string,
    state: (id: string) => ChannelTopic['state'],
  ): ChannelTopic[] {
    return this.directory.list(channel, chatId, state)
  }
}
