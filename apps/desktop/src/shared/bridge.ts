/** Serializable desktop host contract. No SDK or Electron objects cross this boundary. */
type Connection = { connected: boolean; error?: string }
export type Session = {
  sessionId: string
  chatId: string
  chatKind: 'group' | 'direct'
  topic?: { rootId: string; threadId: string }
  task: string
  state: 'running' | 'queued' | 'waiting' | 'done' | 'stopped'
  requester: { id: string; name: string }
  updatedAt: string
  waitingReason?: string
  runId?: string
}
export type Project = {
  id: string
  channel: 'local'
  cwd: string
  name: string
  sessionId: string
}
export type Message = {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  text: string
  createdAt: string
  clientMessageId?: string
}
type ChannelInput = {
  channelId: string
  senderId: string
  senderName: string
  text: string
  images?: { type: 'image'; data: string; mimeType: string }[]
  chatKind?: 'group' | 'direct'
  topic?: { rootId: string; threadId: string }
  replyToId?: string
}
export type Event =
  | {
      type: 'session'
      channel: string
      value: {
        session: Session
        run?:
          | { type: 'started'; runId: string }
          | {
              type: 'finished'
              runId: string
              outcome: 'done' | 'failed' | 'stopped' | 'silent'
            }
      }
    }
  | {
      type: 'status'
      channel: string
      value: { chatId: string; rootId: string; text: string }
    }
  | { type: 'connection'; channel: string; value: Connection }
  | { type: 'local'; channel: 'local'; value: LocalEvent }
type LocalEvent = {
  version: 1
  id: string
  time: string
  projectId?: string
  sessionId?: string
  runId?: string
} & (
  | { type: 'message'; data: Message }
  | { type: 'session'; data: Session }
  | {
      type: 'reset'
      data: { reason: 'connected'; reload: ('sessions' | 'messages')[] }
    }
  | { type: 'run_started'; data: Record<string, never> }
  | {
      type: 'run_finished'
      data: { outcome: 'done' | 'failed' | 'stopped' | 'silent' }
    }
  | {
      type: 'progress'
      data: {
        stage: 'tool' | 'retry' | 'compaction'
        tool?: string
        state?: 'started' | 'finished' | 'failed'
      }
    }
  | { type: 'status'; data: { text: string } }
  | { type: 'error'; data: { code: string; message: string } }
)
export interface DesktopBridge {
  channels(): Promise<{ name: string; description: string }[]>
  sessions(channel: string, chatId?: string): Promise<Session[]>
  connection(channel: string): Promise<Connection>
  submit(
    channel: string,
    message:
      | ChannelInput
      | {
          projectId: string
          sessionId: string
          text: string
          clientMessageId?: string
        },
  ): Promise<{ sessionId: string; messageId?: string }>
  stop(
    channel: string,
    target: { chatId: string; rootId?: string },
    runId: string,
  ): Promise<boolean>
  projects(): Promise<Project[]>
  openProject(input: { cwd: string; name?: string }): Promise<Project>
  /** Native folder picker in main. Cancel and dismissal both return undefined. */
  chooseFolder(): Promise<string | undefined>
  messages(input: {
    projectId: string
    sessionId: string
    after?: string
    limit?: number
  }): Promise<{ messages: Message[]; nextCursor?: string }>
  onEvent(listener: (event: Event) => void): () => void
}
/** IPC channels carry only the fixed methods above, never arbitrary SDK access. */
export const REQUEST = 'vela:request'
export const EVENT = 'vela:event'
export type Request =
  | { method: 'channels' }
  | { method: 'sessions'; channel: string; chatId?: string }
  | { method: 'connection'; channel: string }
  | {
      method: 'submit'
      channel: string
      message:
        | ChannelInput
        | {
            projectId: string
            sessionId: string
            text: string
            clientMessageId?: string
          }
    }
  | {
      method: 'stop'
      channel: string
      target: { chatId: string; rootId?: string }
      runId: string
    }
  | { method: 'projects' }
  | { method: 'openProject'; input: { cwd: string; name?: string } }
  | { method: 'chooseFolder' }
  | {
      method: 'messages'
      input: {
        projectId: string
        sessionId: string
        after?: string
        limit?: number
      }
    }
