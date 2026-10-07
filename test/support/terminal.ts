import { stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui'
import { InteractiveMode } from '../../src/cli/interactive'
import type { Vela } from '../../src/vela'

/** pi-tui 的 Terminal 接口的假实现：不输出，按键直接送给 TUI。 */
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

  /** 逐个字符输入（同真实终端） */
  type(text: string): void {
    for (const char of text) this.onInput?.(char)
  }
  /** 按键：'\r' Enter、'\x1b' Esc、'\x1b\r' Alt+Enter、'\x1b[1;3A' Alt+Up、'\x04' Ctrl+D… */
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

/** afterEach 里调用：退出所有起过的 TUI（停掉转圈的定时器、还原 console） */
export async function stopTuis(): Promise<void> {
  await Promise.all(started.splice(0).map((mode) => mode.shutdown()))
}

/**
 * 在假终端里起交互模式。`screen()` 是当前整屏的文字（去掉颜色），`until()` 等某段文字出现。
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
  /** 等条件成立（1ms 轮询，超时报错并带上当前屏幕） */
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
          `等待超时: ${typeof condition === 'string' ? condition : '条件'}\n${screen()}`,
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
    /** 输入一行并回车 */
    submit: (text: string) => {
      terminal.type(text)
      terminal.press(KEYS.enter)
    },
  }
}
