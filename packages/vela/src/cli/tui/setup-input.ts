import { ProcessTerminal, TuiMainScreen } from '@earendil-works/pi-tui'
import { inputDialog } from './input-dialogs.ts'

/** Reuse setup's input component without constructing Vela, a model or a session. */
export async function setupInput(
  title: string,
  placeholder?: string,
): Promise<string | undefined> {
  const tui = new TuiMainScreen(new ProcessTerminal())
  try {
    return await new Promise<string | undefined>((resolve) => {
      const { component, focus } = inputDialog(
        title,
        placeholder,
        undefined,
        resolve,
      )
      tui.addInputListener((data) => {
        if (data === '\x03' || data === '\x04') {
          resolve(undefined)
          return { consume: true }
        }
      })
      tui.addChild(component)
      tui.setFocus(focus)
      tui.start()
    })
  } finally {
    tui.stop()
  }
}
