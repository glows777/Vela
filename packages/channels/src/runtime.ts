import type { VelaLogger, VelaSession } from '@glows777/vela-core/extension-api'
import { ChannelConnectionState } from './connection.ts'
import type { ChannelDirectory, ChannelRecord } from './directory.ts'
import { isGroupInput } from './directory.ts'
import { errorMessage } from './log.ts'
import { storedMessage } from './recovery.ts'
import { resolveChannelScope } from './scope.ts'
import { channelSessionId } from './session-id.ts'
import type {
  ChannelDefinition,
  ChannelHost,
  ChannelRuntime,
  ChannelSessionSnapshot,
  ChannelSessionUpdate,
  ChannelStatusLine,
} from './types.ts'

interface RuntimeOptions {
  logger: VelaLogger
  channel: ChannelDefinition
  directory: ChannelDirectory
  dataDir: string
  find: (key: string) => VelaSession | undefined
  state: (key: string) => ChannelSessionSnapshot['state']
  run: (key: string) => { runId: string; stopped: boolean } | undefined
  submit: ChannelRuntime['submit']
  stop: ChannelRuntime['stop']
  running: () => boolean
  hostRoutines: ChannelHost['routines']
  operations: Pick<
    ChannelRuntime,
    | 'routines'
    | 'context'
    | 'topics'
    | 'skipReply'
    | 'waitForInput'
    | 'dispatch'
  >
}

/** Public operations share the directory and gateway; this adapter owns no session state. */
export class ScopedChannelRuntime {
  readonly api: ChannelRuntime
  readonly host: ChannelHost
  readonly connection: ChannelConnectionState
  private readonly listeners = new Set<(line: ChannelStatusLine) => void>()

  private readonly sessionListeners = new Set<
    (update: ChannelSessionUpdate) => void
  >()

  constructor(private options: RuntimeOptions) {
    const o = options
    const owned = (id: string): ChannelRecord | undefined => {
      const record = o.directory.get(o.directory.keyForSession(id))
      return record?.channel === o.channel.name ? record : undefined
    }
    const current = (id: string) => {
      const record = owned(id)
      if (!record || record.activeSessionId !== id)
        throw new Error("Operation requires this channel's active session")
      return record
    }
    this.api = {
      ...o.operations,
      submit: o.submit,
      sessions: (chatId) => this.snapshots(chatId),
      stop: o.stop,
      onSession: (listener) => {
        this.sessionListeners.add(listener)
        return () => {
          this.sessionListeners.delete(listener)
        }
      },
      onStatus: (listener) => {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      },
      scope: (id) => {
        const record =
          owned(id) ??
          o.directory
            .entries(o.channel.name)
            .find(
              (entry) => channelSessionId(o.channel.name, entry.chatId) === id,
            )
        return record
          ? resolveChannelScope(
              o.dataDir,
              record.channel,
              record.chatId,
              record.chatKind,
              record.storageKey,
            )
          : undefined
      },
      session: (id) => {
        const record = owned(id)
        return record ? o.find(record.key) : undefined
      },
      context: (id) =>
        owned(id)?.activeSessionId === id
          ? o.operations.context(id)
          : undefined,
      topicCoverage: () => o.directory.coverage,
      skipReply: (id) => {
        current(id)
        o.operations.skipReply(id)
      },
      waitForInput: (id, reason) => {
        current(id)
        return o.operations.waitForInput(id, reason)
      },
      dispatch: (id, message, label) => {
        const record = current(id)
        if (record.chatId !== message.channelId)
          throw new Error('Dispatch must stay in the source conversation')
        o.operations.dispatch(id, message, label)
      },
    }
    this.connection = new ChannelConnectionState(o.channel, o.logger)
    this.host = {
      sessions: (chatId) => this.snapshots(chatId),
      onSession: this.api.onSession,
      onStatus: this.api.onStatus,
      stop: this.api.stop,
      routines: o.hostRoutines,
      connection: this.connection.get,
      onConnection: this.connection.subscribe,
      submit: async (message) => {
        if (!o.running()) throw new Error('Channel is not running')
        // Host topic input cannot create or redirect an owned logical conversation.
        const msg = { ...message, topic: message.topic && { ...message.topic } }
        if (msg.topic) {
          const record = o.directory.get(
            channelSessionId(o.channel.name, msg.channelId, msg.topic.rootId),
          )
          if (!record?.rootId || record.threadId !== msg.topic.threadId)
            throw new Error('Unknown or mismatched channel topic')
          msg.requireExistingSession = true
          msg.chatKind = record.chatKind
        }
        if (isGroupInput(msg) && !msg.replyToId?.trim())
          throw new Error('Host group input requires a service reply anchor')
        return this.api.submit(msg)
      },
    }
  }

  private snapshots(chatId?: string): ChannelSessionSnapshot[] {
    const o = this.options
    return o.directory.entries(o.channel.name).flatMap((record) => {
      if (
        (chatId !== undefined && record.chatId !== chatId) ||
        o.channel.canRecover?.(storedMessage(record), record.chatKind) === false
      )
        return []
      const run = o.run(record.key)
      return [
        {
          sessionId: record.key,
          chatId: record.chatId,
          chatKind: record.chatKind,
          topic:
            record.rootId && record.threadId
              ? { rootId: record.rootId, threadId: record.threadId }
              : undefined,
          task: record.task,
          state: run?.stopped ? 'stopped' : o.state(record.key),
          requester: { ...record.requester },
          updatedAt: record.updatedAt,
          waitingReason: record.waitingReason,
          runId: run && !run.stopped ? run.runId : undefined,
        },
      ]
    })
  }

  status(line: ChannelStatusLine): void {
    for (const listener of this.listeners) {
      try {
        listener({ ...line })
      } catch (error) {
        this.options.logger.warn(
          `[channels] Status listener failed: ${errorMessage(error)}`,
        )
      }
    }
  }

  session(key: string, chatId: string, run: ChannelSessionUpdate['run']): void {
    const snapshot = this.api
      .sessions(chatId)
      .find((entry) => entry.sessionId === key)
    if (!snapshot) return
    for (const listener of this.sessionListeners) {
      try {
        listener(structuredClone({ session: snapshot, run }))
      } catch (error) {
        this.options.logger.warn(
          `[channels] Session listener failed: ${errorMessage(error)}`,
        )
      }
    }
  }

  clear(): void {
    this.connection.clear()
    this.sessionListeners.clear()
    this.listeners.clear()
  }
}
