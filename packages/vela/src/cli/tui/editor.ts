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
  | 'cycleModelForward'
  | 'cycleModelBackward'
  | 'expandTools'
  | 'toggleThinking'
  | 'pasteImage'

function pasteImageKey(platform: string): KeyId {
  return platform === 'win32' ? 'alt+v' : 'ctrl+v'
}

const APP_KEYS: Record<AppAction, KeyId> = {
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
  pasteImage: pasteImageKey(process.platform),
}

/** Modifier names as keys read, with the macOS name second (Alt is Option there). */
const MODIFIER_NAMES: Record<string, [other: string, mac: string]> = {
  ctrl: ['Ctrl', 'Ctrl'],
  shift: ['Shift', 'Shift'],
  alt: ['Alt', 'Option'],
  super: ['Win', 'Cmd'],
}

const KEY_NAMES: Record<string, string> = {
  escape: 'Esc',
  esc: 'Esc',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'Page Up',
  pagedown: 'Page Down',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
}

/** A key id as the user sees it: `alt+up` → `Alt+Up`, or `Option+Up` on macOS. */
export function formatKeyId(
  key: KeyId,
  platform: string = process.platform,
): string {
  return key
    .split('+')
    .map((part) => {
      const modifier = MODIFIER_NAMES[part]
      if (modifier) return platform === 'darwin' ? modifier[1] : modifier[0]
      return KEY_NAMES[part.toLowerCase()] ?? part.toUpperCase()
    })
    .join('+')
}

/** How an app action's key reads in hints and `/hotkeys`. */
export function keyLabel(
  action: AppAction,
  platform: string = process.platform,
): string {
  const key =
    action === 'pasteImage' ? pasteImageKey(platform) : APP_KEYS[action]
  return formatKeyId(key, platform)
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
