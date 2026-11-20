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
  /** Defined in models.json rather than built in. */
  custom: boolean
  models: SettingsModel[]
}
/** What the pages show of Vela's configuration. Keys never cross this boundary. */
export type SettingsState = {
  /** The user directory (VELA_DIR). */
  folder: string
  /** The files a model choice writes. */
  files: { settings: string; models: string; auth: string }
  /** Nothing can answer before a model and its credential are saved. */
  setup: {
    required: boolean
    reason?: 'no-model' | 'missing-credential' | 'unknown-model'
    /** The provider that has no credential, for `missing-credential`. */
    provider?: string
  }
  /** The saved default model, `provider/id`. */
  model?: string
  thinkingLevel?: string
  lark: {
    appId: string
    appSecretSaved: boolean
    chats: string[]
    envExpression: boolean
    runInApp: boolean
    loaded: boolean
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
/** A provider and model to check and then save. */
export type ModelSetup = {
  provider: string
  model: string
  /** A new API key; absent keeps the saved one. */
  key?: string
  /** A provider that models.json doesn't define yet; saved with this model. */
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
  /** Vela's configuration, without the contents of settings.json, models.json or auth.json. */
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
