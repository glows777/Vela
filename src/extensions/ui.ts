import type { VelaEvent } from '../agent/events.ts'

/**
 * How extensions interact with the user (a trimmed-down version of pi's ctx.ui). With no UI (SDK, `-p`,
 * channel sessions), notify becomes a `notify` event, confirm returns false, select / input return
 * undefined, and setStatus / setWidget do nothing.
 * In RPC mode they become `extension_ui_request` events that the client answers.
 */
export interface ExtensionUI {
  notify(message: string, level?: 'info' | 'warning' | 'error'): void
  confirm(title: string, message: string): Promise<boolean>
  select(title: string, options: string[]): Promise<string | undefined>
  input(title: string, placeholder?: string): Promise<string | undefined>
  /** A status entry in the footer (keyed by key; empty text clears it) */
  setStatus(key: string, text?: string): void
  /** Lines of text above the input box (keyed by key; empty lines clears them) */
  setWidget(key: string, lines?: string[]): void
}

/** The UI passed in session options: setStatus / setWidget are optional (no-ops when missing). */
export type SessionUI = Omit<ExtensionUI, 'setStatus' | 'setWidget'> &
  Partial<Pick<ExtensionUI, 'setStatus' | 'setWidget'>>

/** ExtensionUI without a real UI: notify becomes an event, and anything needing an answer is treated as "no / no answer" (like pi). */
export function headlessUI(emit: (event: VelaEvent) => void): ExtensionUI {
  return {
    notify: (message, level = 'info') =>
      emit({ type: 'notify', message, level }),
    confirm: async () => false,
    select: async () => undefined,
    input: async () => undefined,
    setStatus: () => {},
    setWidget: () => {},
  }
}

/** Fills in setStatus / setWidget the UI doesn't implement (no-ops). */
export function withDefaults(ui: SessionUI): ExtensionUI {
  return {
    notify: (message, level) => ui.notify(message, level),
    confirm: (title, message) => ui.confirm(title, message),
    select: (title, options) => ui.select(title, options),
    input: (title, placeholder) => ui.input(title, placeholder),
    setStatus: (key, text) => ui.setStatus?.(key, text),
    setWidget: (key, lines) => ui.setWidget?.(key, lines),
  }
}
