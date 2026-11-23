import { Check, ChevronDown } from 'lucide-react'
import { type KeyboardEvent, type Ref, useId, useRef, useState } from 'react'
import styles from './select.module.css'

type Option<T extends string> = { value: T; label: string }

/** A select-only combobox. The browser's popover keeps the list out of dock/dialog clipping. */
export function Select<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  disabled,
  compact,
  triggerRef,
}: {
  id?: string
  label: string
  value: T
  options: readonly Option<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  compact?: boolean
  triggerRef?: Ref<HTMLButtonElement>
}) {
  const listId = useId()
  const menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const selected = options.findIndex((item) => item.value === value)
  const itemId = (index: number) => `${listId}-${index}`

  const highlight = (index: number) => {
    setActive(index)
    document.getElementById(itemId(index))?.scrollIntoView({ block: 'nearest' })
  }

  const choose = (index: number) => {
    const option = options[index]
    if (!option) return
    menu.current?.hidePopover()
    onChange(option.value)
  }

  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const { key } = event
    if (key === 'Tab') {
      menu.current?.hidePopover()
      return
    }
    if (key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      menu.current?.hidePopover()
      return
    }
    if (open && (key === 'Enter' || key === ' ')) {
      event.preventDefault()
      choose(active)
      return
    }
    if (
      key === 'ArrowDown' ||
      key === 'ArrowUp' ||
      key === 'Home' ||
      key === 'End'
    ) {
      event.preventDefault()
      if (!open) event.currentTarget.click()
      const next = !open ? Math.max(0, selected) : active
      if (key === 'Home') highlight(0)
      else if (key === 'End') highlight(options.length - 1)
      else if (open)
        highlight(
          Math.max(
            0,
            Math.min(options.length - 1, next + (key === 'ArrowDown' ? 1 : -1)),
          ),
        )
      return
    }
    if (
      key.length !== 1 ||
      key === ' ' ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return
    if (!open) event.currentTarget.click()
    const from = open ? active : selected
    const prefix = key.toLocaleLowerCase()
    const offset = Array.from(
      { length: options.length },
      (_, i) => (i + from + 1) % options.length,
    ).find((i) => options[i]?.label.toLocaleLowerCase().startsWith(prefix))
    if (offset !== undefined) highlight(offset)
    event.preventDefault()
  }

  return (
    <>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={
          open && options[active] ? itemId(active) : undefined
        }
        popoverTarget={listId}
        disabled={disabled || options.length === 0}
        className={
          compact ? `${styles.trigger} ${styles.compact}` : styles.trigger
        }
        onClick={(event) => {
          event.currentTarget.focus()
          if (!open) setActive(Math.max(0, selected))
        }}
        onKeyDown={keyDown}
        onBlur={() => menu.current?.hidePopover()}
      >
        <span className={styles.value}>
          {options[selected]?.label ?? 'Choose…'}
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <div
        id={listId}
        role="listbox"
        aria-label={label}
        className={styles.menu}
        ref={menu}
        popover="auto"
        onToggle={(event) => {
          const shown = event.newState === 'open'
          setOpen(shown)
          if (shown)
            document
              .getElementById(itemId(active))
              ?.scrollIntoView({ block: 'nearest' })
        }}
      >
        {options.map((item, index) => (
          <button
            key={item.value}
            type="button"
            tabIndex={-1}
            id={itemId(index)}
            role="option"
            aria-selected={index === selected}
            data-active={index === active || undefined}
            className={styles.option}
            onPointerDown={(event) => event.preventDefault()}
            onPointerMove={() => setActive(index)}
            onClick={() => choose(index)}
          >
            <span>{item.label}</span>
            {index === selected ? <Check size={14} aria-hidden="true" /> : null}
          </button>
        ))}
      </div>
    </>
  )
}
