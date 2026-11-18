import type { Message } from '../../shared/bridge.ts'
import { Wordmark } from '../frame/wordmark.tsx'
import styles from './message.module.css'

/** A person's message is a bubble; Vela answers in plain text under its wordmark. */
export function MessageView({ message }: { message: Message }) {
  if (message.role === 'system')
    return (
      <p className={styles.system} data-role="system">
        {message.text}
      </p>
    )
  if (message.role === 'user')
    return (
      <div className={styles.user} data-role="user">
        <p className={styles.bubble}>{message.text}</p>
      </div>
    )
  return (
    <article className={styles.assistant} data-role="assistant">
      <p className={styles.turn}>
        <Wordmark small />
      </p>
      <p className={styles.text}>{message.text}</p>
    </article>
  )
}
