/** Serializable desktop host contract. No SDK or Electron objects cross this boundary. */
export type Connection = { connected: boolean; error?: string }
export type Session = {
  /** The channel that owns it: `local` or `lark`. */
  channel: string
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
/** A folder on this computer, named by its folder. */
type LocalProject = {
  id: string
  channel: 'local'
  cwd: string
  name: string
  sessionId: string
}
/** A Lark group. `id` is its chat id; a group with no readable name shows it. */
type LarkProject = {
  id: string
  channel: 'lark'
  name?: string
  sessionId: string
}
export type Project = LocalProject | LarkProject
export type Message = {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  text: string
  createdAt: string
  /** Who wrote it in a Lark group; absent in a Local project. */
  senderName?: string
  clientMessageId?: string
}
/**
 * A group message from this app: the bot posts it in the group, signed with the
 * `Vela app` constant, so Lark records it as the bot's own message.
 */
export type LarkSubmit =
  | { chatId: string; sessionId: string; text: string }
  | { chatId: string; newTopic: { title: string }; text: string }
export type SubmitReceipt = {
  /** `posted`: it is in Lark. `uncertain`: it may be. `not-sent`: nothing was posted. */
  outcome: 'posted' | 'uncertain' | 'not-sent'
  sessionId?: string
  messageId?: string
  topic?: { rootId: string; threadId: string }
  /** Why a submission did not finish: a plain `posted` carries none. */
  error?: string
}
/** One model a provider offers, without anything that would name a key. */
type SettingsModel = {
  id: string
  contextWindow?: number
  reasoning?: boolean
}
export type SettingsProvider = {
  name: string
  /** Where its credential comes from ('auth.json', 'OPENAI_API_KEY', …); absent when none is saved. */
  credential?: string
  /** Defined in config.json rather than built in. */
  custom: boolean
  models: SettingsModel[]
}
/** What the pages show of Vela's configuration. Keys never cross this boundary. */
export type SettingsState = {
  /** The user directory (VELA_DIR). */
  folder: string
  /** The files a model choice writes. */
  files: { config: string; auth: string }
  /** Nothing can answer before a model and its credential are saved. */
  setup: {
    required: boolean
    reason?: 'no-model' | 'missing-credential' | 'unknown-model'
    /** The provider that has no credential, for `missing-credential`. */
    provider?: string
  }
  /** The saved default model, `provider/id`. */
  model?: string
  thinkingLevel?: ThinkingLevel | 'max'
  lark: {
    appId: string
    appSecretSaved: boolean
    chats: string[]
    envExpression: boolean
    runInApp: boolean
    loaded: boolean
    startupError?: string
  }
  providers: SettingsProvider[]
}
export type LarkSetup =
  | { appId: string; appSecret?: string }
  | { removeChat: string }
  | { runInApp: boolean }
export type ProviderApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]
/** A provider and model to check and then save. */
export type ModelSetup = {
  provider: string
  model: string
  /** A new API key; absent keeps the saved one. */
  key?: string
  /** Absent keeps the saved default. */
  thinkingLevel?: ThinkingLevel
  /** A provider that config.json doesn't define yet; saved with this model. */
  custom?: { api: ProviderApi; baseUrl: string }
}
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
/**
 * Deployment-local wall clock, as the host takes it: `at` is `YYYY-MM-DDTHH:mm` with
 * no offset, and `time` is `HH:MM`. Nothing here is UTC.
 */
export type RoutineSchedule =
  | { at: string }
  | { time: string; days?: Weekday[] }
/** A routine as the host records it, with the display strings it built for its timezone. */
export type Routine = {
  id: string
  message: string
  /** A stored one-off `at` is the UTC instant the host resolved; its wall clock is in `scheduleText`. */
  schedule: RoutineSchedule
  creator: { id: string; name: string }
  timezone: string
  /** Local wall clock, such as `2026-11-21 09:00` or `mon,tue at 09:00`. */
  scheduleText: string
  /** `Group channel`, `Topic: <task>` or `Direct chat`, in the host's words. */
  target: string
  /** Local wall clock of the next run; null when the host finds none. */
  nextRun: string | null
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
      value: {
        chatId: string
        rootId: string
        text: string
        /** The logical session the line belongs to, for the page to file it. */
        sessionId?: string
      }
    }
  | { type: 'connection'; channel: string; value: Connection }
  | { type: 'local'; channel: 'local'; value: LocalEvent }
  /** Lark history is read, not streamed: re-read on `reset` or after a change. */
  | { type: 'lark'; channel: 'lark'; value: LarkEvent }
type LarkEvent =
  | { type: 'reset' }
  | { type: 'history_changed'; chatId: string; sessionId?: string }
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
  /** Vela's configuration, without the contents of config.json or auth.json. */
  settings(): Promise<SettingsState>
  /** Checks the key with one small request, then saves the choice; returns the new state. */
  saveModel(input: ModelSetup): Promise<SettingsState>
  saveLark(input: LarkSetup): Promise<SettingsState>
  sessions(channel: string, chatId?: string): Promise<Session[]>
  connection(channel: string): Promise<Connection>
  submit(
    channel: string,
    message:
      | ChannelInput
      | LarkSubmit
      | {
          projectId: string
          sessionId: string
          text: string
          clientMessageId?: string
        },
  ): Promise<SubmitReceipt>
  stop(
    channel: string,
    target: { chatId: string; rootId?: string },
    runId: string,
  ): Promise<boolean>
  /** Wait for a mention. A cancelled wait returns undefined. Only main keeps the group to save. */
  discoverLarkGroup(): Promise<{ chatId: string; name?: string } | undefined>
  confirmLarkGroup(): Promise<void>
  cancelLarkSetup(): Promise<void>
  projects(): Promise<Project[]>
  openProject(input: { cwd: string; name?: string }): Promise<LocalProject>
  /** Native folder picker in main. Cancel and dismissal both return undefined. */
  chooseFolder(): Promise<string | undefined>
  messages(input: {
    projectId: string
    sessionId: string
    after?: string
    limit?: number
  }): Promise<{ messages: Message[]; nextCursor?: string }>
  /** Group history newest first, topic history oldest first. */
  larkMessages(input: {
    chatId: string
    sessionId: string
    cursor?: string
    limit?: number
  }): Promise<{ messages: Message[]; nextCursor?: string }>
  /** Opens the enabled group in Lark. A topic has no documented deep link. */
  openLarkChat(chatId: string): Promise<void>
  openMessageLink(url: string): Promise<void>
  copyMessageCode(text: string): Promise<void>
  listRoutines(
    channel: string,
    chatId: string,
  ): Promise<{ timezone: string; routines: Routine[] }>
  createRoutine(
    channel: string,
    target: { chatId: string; rootId?: string },
    input: { message: string; schedule: RoutineSchedule },
  ): Promise<Routine>
  editRoutine(
    channel: string,
    chatId: string,
    id: string,
    input: { message?: string; schedule?: RoutineSchedule },
  ): Promise<Routine | undefined>
  cancelRoutine(channel: string, chatId: string, id: string): Promise<boolean>
  onEvent(listener: (event: Event) => void): () => void
}
/** IPC channels carry only the fixed methods above, never arbitrary SDK access. */
export const REQUEST = 'vela:request'
export const EVENT = 'vela:event'
export type Request =
  | { method: 'channels' }
  | { method: 'settings' }
  | { method: 'saveLark'; input: LarkSetup }
  | { method: 'saveModel'; input: ModelSetup }
  | { method: 'sessions'; channel: string; chatId?: string }
  | { method: 'connection'; channel: string }
  | {
      method: 'submit'
      channel: string
      message:
        | ChannelInput
        | LarkSubmit
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
  | { method: 'discoverLarkGroup' | 'confirmLarkGroup' | 'cancelLarkSetup' }
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
  | {
      method: 'larkMessages'
      input: {
        chatId: string
        sessionId: string
        cursor?: string
        limit?: number
      }
    }
  | { method: 'openLarkChat'; chatId: string }
  | { method: 'openMessageLink'; url: string }
  | { method: 'copyMessageCode'; text: string }
  | { method: 'listRoutines'; channel: string; chatId: string }
  | {
      method: 'createRoutine'
      channel: string
      target: { chatId: string; rootId?: string }
      input: { message: string; schedule: RoutineSchedule }
    }
  | {
      method: 'editRoutine'
      channel: string
      chatId: string
      id: string
      input: { message?: string; schedule?: RoutineSchedule }
    }
  | { method: 'cancelRoutine'; channel: string; chatId: string; id: string }
