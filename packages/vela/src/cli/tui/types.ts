import type { Terminal } from '@earendil-works/pi-tui'
import type {
  ImageContent,
  LoginOptions,
  VelaSession,
} from '@glows777/vela-core'
import type { Vela } from '../../vela.ts'

export type LogLevel = 'info' | 'warning' | 'error'

export interface InteractiveOptions {
  vela: Vela
  /** Command-line prompts and attachments, sent after startup. */
  messages?: string[]
  images?: ImageContent[]
  /** Session at startup */
  sessionId: string
  /** Restore this session's history at startup (`-c` / `--session`) */
  resume: boolean
  /** `-r`: pick from saved sessions at startup */
  pick: boolean
  /** Id for a new session (`/new`) */
  newSessionId: () => string
  /** Called after a session opens (and resumes): command-line --model / --thinking override saved settings; returns whether the model is usable */
  configure: (session: VelaSession) => boolean
  /** Called before exit (dispose, write the recording file) */
  onExit: () => Promise<void>
  /** Fake terminal for tests; defaults to the real terminal */
  terminal?: Terminal
  /** Attach the logger: warn / error show in the chat log */
  attachLogger?: (sink: (level: LogLevel, message: string) => void) => void
  /** Rewrites an error for display (the CLI swaps the SDK's no-model hint for its own) */
  describeError?: (error: unknown) => string
  /** Clipboard for `/copy`; defaults to the system clipboard (tests pass a fake) */
  copyToClipboard?: (text: string) => Promise<void>
  /** Defaults to pi-tui's native clipboard or wl-paste on Wayland. */
  readClipboardImage?: () => Promise<Uint8Array | undefined>
  /** Text fallback for the explicit paste shortcut when there is no image. */
  readClipboardText?: () => Promise<string | undefined>
  /** Passed to `vela.login()` by `/login` (the CLI's installation id for Sign in with ChatGPT) */
  loginOptions?: LoginOptions
  /** Opens a sign-in URL; defaults to the system browser (tests pass a fake) */
  openBrowser?: (url: string) => void
  /** Settings `enabledModels`: the models Ctrl+P cycles through */
  enabledModels?: string[]
  /** Configured agent directory (`VELA_DIR` or `~/.vela`), for `/status` path shortening */
  agentDir?: string
}
