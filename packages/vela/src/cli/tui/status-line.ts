import {
  type Container,
  Loader,
  type TuiAltScreen,
} from '@earendil-works/pi-tui'
import { theme } from './theme.ts'

/**
 * The spinner line above the editor: what the run is doing right now (thinking, answering, running a tool) and
 * the wait before a retried request. Like pi, a retry is this line and not a chat message, so a retry that
 * succeeds leaves nothing behind in the transcript (#566).
 */
export class StatusLine {
  private loader?: Loader
  /** Ends a retry's status line when its backoff does: the attempt is in flight again */
  private retryTimer?: ReturnType<typeof setTimeout>

  constructor(
    private readonly tui: TuiAltScreen,
    private readonly container: Container,
  ) {}

  /** Show the line, starting its spinner if this is the first message of a run */
  start(message: string): void {
    if (!this.loader) {
      this.loader = new Loader(
        this.tui,
        (text) => theme.fg('accent', text),
        (text) => theme.fg('muted', text),
        message,
      )
      this.container.clear()
      // The loader's own render opens with a blank line; a spacer here would leave two
      this.container.addChild(this.loader)
      this.loader.start()
    }
    this.set(message)
  }

  set(message: string): void {
    this.loader?.setMessage(
      `${message} ${theme.fg('dim', '(Esc to interrupt)')}`,
    )
  }

  stop(): void {
    this.clearRetry()
    this.loader?.stop()
    this.loader = undefined
    this.container.clear()
  }

  /** Say a retried request is waiting, then go back to thinking when the backoff ends */
  retry(message: string, delayMs: number): void {
    this.clearRetry()
    this.set(message)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      // The attempt is in flight again; its first text or tool call renames the line as usual
      this.set('Thinking…')
    }, delayMs)
  }

  private clearRetry(): void {
    if (this.retryTimer === undefined) return
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }
}
