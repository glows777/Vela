import { stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui'
import { InteractiveMode } from '../../src/cli/interactive.ts'
import type { Vela } from '../../src/vela.ts'

/** Fake implementation of pi-tui's Terminal interface: writes nothing and sends keys straight to the TUI. */
export class FakeTerminal implements Terminal {
  private onInput?: (data: string) => void
  columns = 100
  rows = 40
  kittyProtocolActive = false

  start(onInput: (data: string) => void): void {
    this.onInput = onInput
  }
  stop(): void {
    this.onInput = undefined
  }
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  /** Type one character at a time (like a real terminal) */
  type(text: string): void {
    for (const char of text) this.onInput?.(char)
  }
  /** Press a key: '\r' Enter, '\x1b' Esc, '\x1b\r' Alt+Enter, '\x1b[1;3A' Alt+Up, '\x04' Ctrl+D… */
  press(key: string): void {
    this.onInput?.(key)
  }
}

export const KEYS = {
  enter: '\r',
  escape: '\x1b',
  altEnter: '\x1b\r',
  altUp: '\x1b[1;3A',
  down: '\x1b[B',
  shiftTab: '\x1b[Z',
  ctrlC: '\x03',
  ctrlD: '\x04',
  ctrlL: '\x0c',
  ctrlO: '\x0f',
}

const started: InteractiveMode[] = []

/** Call in afterEach: shuts down every started TUI (stops spinner timers, restores console) */
export async function stopTuis(): Promise<void> {
  await Promise.all(started.splice(0).map((mode) => mode.shutdown()))
}

/**
 * Starts interactive mode in a fake terminal. `screen()` is the current screen text (colors stripped); `until()` waits for some text to appear.
 */
export async function startTui(
  vela: Vela,
  options: {
    sessionId?: string
    resume?: boolean
    pick?: boolean
    newSessionId?: () => string
  } = {},
) {
  const terminal = new FakeTerminal()
  let exited = false
  let ids = 0
  const mode = new InteractiveMode({
    vela,
    sessionId: options.sessionId ?? 'tui',
    resume: options.resume ?? false,
    pick: options.pick ?? false,
    newSessionId: options.newSessionId ?? (() => `tui-new-${++ids}`),
    configure: () => true,
    onExit: async () => {
      exited = true
    },
    terminal,
  })
  started.push(mode)
  const ready = mode.start()
  const screen = () =>
    mode.tui
      .render(terminal.columns)
      .map((line) => stripTerminalSequences(line).trimEnd())
      .join('\n')
  /** Wait until a condition holds (polls every 1 ms; on timeout, throws with the current screen) */
  const until = async (
    condition: string | (() => boolean),
    timeoutMs = 2000,
  ) => {
    const check =
      typeof condition === 'string'
        ? () => screen().includes(condition)
        : condition
    const deadline = Date.now() + timeoutMs
    while (!check()) {
      if (Date.now() > deadline)
        throw new Error(
          `Timed out waiting for: ${typeof condition === 'string' ? condition : 'condition'}\n${screen()}`,
        )
      await Bun.sleep(1)
    }
  }
  return {
    mode,
    terminal,
    started: ready,
    screen,
    until,
    exited: () => exited,
    /** Type a line and press Enter */
    submit: (text: string) => {
      terminal.type(text)
      terminal.press(KEYS.enter)
    },
  }
}
