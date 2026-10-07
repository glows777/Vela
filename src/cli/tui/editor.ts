import { Editor, type KeyId, matchesKey } from '@earendil-works/pi-tui'

/** 应用级快捷键（同 pi 的默认键位）。 */
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

/** pi-tui 的 Editor，先处理应用快捷键（同 pi 的 CustomEditor）。 */
export class VelaEditor extends Editor {
  readonly actions = new Map<AppAction, () => void>()

  override handleInput(data: string): void {
    for (const [action, handler] of this.actions) {
      if (!matchesKey(data, APP_KEYS[action])) continue
      // Esc 先给补全菜单用；Ctrl+D 只在输入框为空时退出，否则是向后删除
      if (action === 'interrupt' && this.isShowingAutocomplete()) break
      if (action === 'exit' && this.getText().length > 0) break
      handler()
      return
    }
    super.handleInput(data)
  }
}
