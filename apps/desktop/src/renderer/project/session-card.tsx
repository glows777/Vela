import type { Session } from '../../shared/bridge.ts'
import { StateMark } from '../components/state-mark.tsx'
import { stateWord } from '../format.ts'
import styles from './session-card.module.css'

/**
 * A session's place in the project conversation. Local records the session's title
 * message and no reply on the turn that started it, so the card is anchored there.
 */
export function SessionCard({ session }: { session: Session }) {
  const waiting = session.state === 'waiting' && session.waitingReason
  return (
    <article
      className={[styles.card, waiting ? styles.waiting : ''].join(' ')}
      aria-label={`Session: ${session.task}`}
    >
      <p className={styles.head}>
        <StateMark state={session.state} />
        <span className={styles.title}>{session.task}</span>
        <span className={styles.word}>{stateWord[session.state]}</span>
      </p>
      {waiting ? (
        <p className={styles.question}>{session.waitingReason}</p>
      ) : null}
    </article>
  )
}
