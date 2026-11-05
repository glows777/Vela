import { Input, type SelectItem, SelectList } from '@earendil-works/pi-tui'
import { dialogBox, SecretInput } from './components.ts'
import { selectListTheme } from './theme.ts'

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
  secret: boolean,
  close: (value: string | undefined) => void,
) {
  let closed = false
  const done = (value: string | undefined) => {
    if (closed) return
    closed = true
    close(value)
  }
  if (signal?.aborted) queueMicrotask(() => done(undefined))
  else signal?.addEventListener('abort', () => done(undefined), { once: true })
  const input = secret ? new SecretInput() : new Input()
  input.onSubmit = (value) => done(value.trim() || undefined)
  input.onEscape = () => done(undefined)
  const hint = placeholder
    ? `${placeholder} · Enter confirm · Esc cancel`
    : 'Enter confirm · Esc cancel'
  return { component: dialogBox(title, input, hint), focus: input }
}
