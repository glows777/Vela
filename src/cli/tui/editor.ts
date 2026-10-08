import { Editor, type KeyId, matchesKey } from '@earendil-works/pi-tui'

/** App-level keybindings (pi's defaults). */
export type AppAction =
  | 'interrupt'
  | 'clear'
  | 'exit'
  | 'followUp'
  | 'dequeue'
  | 'cycleThinking'
  | 'selectModel'
  | 'expandTools'
  | 'toggleThinking'

export const APP_KEYS: Record<AppAction, KeyId> = {
  interrupt: 'escape',
  clear: 'ctrl+c',
  exit: 'ctrl+d',
  followUp: 'alt+enter',
  dequeue: 'alt+up',
  cycleThinking: 'shift+tab',
  selectModel: 'ctrl+l',
  expandTools: 'ctrl+o',
  toggleThinking: 'ctrl+t',
}

/** pi-tui's Editor, handling app keybindings first (like pi's CustomEditor). */
export class VelaEditor extends Editor {
  readonly actions = new Map<AppAction, () => void>()

  override handleInput(data: string): void {
    for (const [action, handler] of this.actions) {
      if (!matchesKey(data, APP_KEYS[action])) continue
      // Esc goes to the autocomplete menu first; Ctrl+D exits only when the editor is empty, otherwise it deletes forward
      if (action === 'interrupt' && this.isShowingAutocomplete()) break
      if (action === 'exit' && this.getText().length > 0) break
      handler()
      return
    }
    super.handleInput(data)
  }
}
