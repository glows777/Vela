import type { Message } from '../../shared/bridge.ts'
import styles from './message.module.css'

/** A person's message is a bubble; Vela answers directly in clean prose without repeated headers. */
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
      <p className={styles.text}>{message.text}</p>
    </article>
  )
}
