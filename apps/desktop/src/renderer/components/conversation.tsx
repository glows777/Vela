import { type ReactNode, useEffect, useRef } from 'react'
import styles from './conversation.module.css'

/** The scrolling conversation column. New turns follow only when the reader is at the bottom. */
export function Conversation({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  const box = useRef<HTMLElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    const node = box.current
    if (node && pinned.current) node.scrollTop = node.scrollHeight
  })

  return (
    <section
      ref={box}
      className={styles.conversation}
      aria-label={label}
      onScroll={(event) => {
        const node = event.currentTarget
        pinned.current =
          node.scrollHeight - node.scrollTop - node.clientHeight < 48
      }}
    >
      {children}
    </section>
  )
}
