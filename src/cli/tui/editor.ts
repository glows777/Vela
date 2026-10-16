import {
  Editor,
  getKeybindings,
  type KeyId,
  matchesKey,
} from '@earendil-works/pi-tui'

/** App-level keybindings (pi's defaults). */
export type AppAction =
  | 'interrupt'
  | 'clear'
  | 'exit'
  | 'followUp'
  | 'dequeue'
  | 'cycleThinking'
  | 'selectModel'
  | 'cycleModelForward'
  | 'cycleModelBackward'
  | 'expandTools'
  | 'toggleThinking'
  | 'pasteImage'

export const APP_KEYS: Record<AppAction, KeyId> = {
  interrupt: 'escape',
  clear: 'ctrl+c',
  exit: 'ctrl+d',
  followUp: 'alt+enter',
  dequeue: 'alt+up',
  cycleThinking: 'shift+tab',
  selectModel: 'ctrl+l',
  cycleModelForward: 'ctrl+p',
  cycleModelBackward: 'shift+ctrl+p',
  expandTools: 'ctrl+o',
  toggleThinking: 'ctrl+t',
  pasteImage: process.platform === 'win32' ? 'alt+v' : 'ctrl+v',
}

/** pi-tui's Editor, handling app keybindings first (like pi's CustomEditor). */
export class VelaEditor extends Editor {
  readonly actions = new Map<AppAction, () => void>()
  /** Consume a submit before pi clears the draft and cursor (e.g. while a paste is pending). */
  onBeforeSubmit?: () => boolean
  private bracketedPaste = false

  override handleInput(data: string): void {
    if (this.bracketedPaste || data.includes('\x1b[200~')) {
      this.bracketedPaste = !data.includes('\x1b[201~')
      super.handleInput(data)
      return
    }
    for (const [action, handler] of this.actions) {
      if (!matchesKey(data, APP_KEYS[action])) continue
      // Esc goes to the autocomplete menu first; Ctrl+D exits only when the editor is empty, otherwise it deletes forward
      if (action === 'interrupt' && this.isShowingAutocomplete()) break
      if (action === 'exit' && this.getText().length > 0) break
      handler()
      return
    }
    const keys = getKeybindings()
    const cursor = this.getCursor()
    if (
      keys.matches(data, 'tui.input.submit') &&
      !keys.matches(data, 'tui.input.newLine') &&
      data !== '\n' &&
      !this.disableSubmit &&
      !this.isShowingAutocomplete() &&
      this.getLines()[cursor.line]?.[cursor.col - 1] !== '\\' &&
      this.onBeforeSubmit?.()
    )
      return
    super.handleInput(data)
  }
}
