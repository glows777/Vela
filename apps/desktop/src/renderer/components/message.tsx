import type { Message } from '../../shared/bridge.ts'
import styles from './message.module.css'

/**
 * A person's message is a bubble; Vela answers in plain text. In a
 * Lark group every person keeps their name, and the app's own posts are the bot's.
 */
export function MessageView({
  message,
  group = false,
}: {
  message: Message
  group?: boolean
}) {
  if (message.role === 'system')
    return (
      <p className={styles.system} data-role="system">
        {message.text}
      </p>
    )
  if (message.role === 'user')
    return group ? (
      <div className={styles.person} data-role="user">
        <p className={styles.name}>{message.senderName ?? 'Someone'}</p>
        <p className={styles.bubble}>{message.text}</p>
      </div>
    ) : (
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
