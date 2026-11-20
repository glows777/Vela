import { type ReactNode, useLayoutEffect, useRef } from 'react'
import styles from './conversation.module.css'

/** Where each conversation was left, so switching projects or sessions keeps its place. */
const places = new Map<string, number>()

/**
 * The scrolling conversation column. A conversation opens where it was left, or at
 * its newest turn; new turns follow only when the reader is at the bottom.
 */
export function Conversation({
  label,
  place,
  centered = false,
  children,
}: {
  label: string
  place: string
  /** Centers messages in a 720px reading column while keeping the scrollbar at the pane edge. */
  centered?: boolean
  children: ReactNode
}) {
  const box = useRef<HTMLElement>(null)
  const pinned = useRef(true)

  useLayoutEffect(() => {
    const node = box.current
    if (!node) return
    const saved = places.get(place)
    node.scrollTop = saved ?? node.scrollHeight
    pinned.current =
      saved === undefined ||
      node.scrollHeight - node.scrollTop - node.clientHeight < 48
  }, [place])

  useLayoutEffect(() => {
    const node = box.current
    if (node && pinned.current) node.scrollTop = node.scrollHeight
  })

  return (
    <section
      ref={box}
      className={[styles.conversation, centered ? styles.centered : '']
        .filter(Boolean)
        .join(' ')}
      aria-label={label}
      onScroll={(event) => {
        const node = event.currentTarget
        places.set(place, node.scrollTop)
        pinned.current =
          node.scrollHeight - node.scrollTop - node.clientHeight < 48
      }}
    >
      {children}
    </section>
  )
}
