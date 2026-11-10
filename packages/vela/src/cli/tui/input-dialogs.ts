import { Input, type SelectItem, SelectList } from '@earendil-works/pi-tui'
import { dialogBox, SecretInput } from './components.ts'
import { selectListTheme } from './theme.ts'

/** Close a dialog once: the first selection or abort wins, and the abort listener is removed. */
export function settleOnce(
  signal: AbortSignal | undefined,
  done: (value: string | undefined) => void,
): (value: string | undefined) => void {
  let closed = false
  const close = (value: string | undefined) => {
    if (closed) return
    closed = true
    signal?.removeEventListener('abort', abort)
    done(value)
  }
  const abort = () => close(undefined)
  if (signal?.aborted) queueMicrotask(abort)
  else signal?.addEventListener('abort', abort, { once: true })
  return close
}

export function selectDialog(
  title: string,
  items: SelectItem[],
  selected: string | undefined,
  signal: AbortSignal | undefined,
  done: (value: string | undefined) => void,
) {
  const list = new SelectList(items, 10, selectListTheme)
  const index = items.findIndex((item) => item.value === selected)
  if (index > 0) list.setSelectedIndex(index)
  const close = settleOnce(signal, done)
  list.onSelect = (item) => close(item.value)
  list.onCancel = () => close(undefined)
  return {
    component: dialogBox(
      title,
      list,
      '↑↓ navigate · Enter select · Esc cancel',
    ),
    focus: list,
  }
}

export function inputDialog(
  title: string,
  placeholder: string | undefined,
  signal: AbortSignal | undefined,
  close: (value: string | undefined) => void,
  secret = false,
  allowEmpty = false,
) {
  const done = settleOnce(signal, close)
  const input = secret ? new SecretInput() : new Input()
  input.onSubmit = (value) =>
    done(allowEmpty ? value.trim() : value.trim() || undefined)
  input.onEscape = () => done(undefined)
  const hint = placeholder
    ? `${placeholder} · Enter confirm · Esc cancel`
    : 'Enter confirm · Esc cancel'
  return { component: dialogBox(title, input, hint), focus: input }
}
