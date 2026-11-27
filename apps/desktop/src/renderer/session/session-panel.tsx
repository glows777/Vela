import { ChevronRight, Plus, X } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { Session } from '../../shared/bridge.ts'
import { StateMark } from '../components/state-mark.tsx'
import { groupSessions } from '../format.ts'
import { Button } from '../ui/button.tsx'
import { velaMotion } from '../ui/motion.ts'
import styles from './session-panel.module.css'

const groupHeading = (label: string) =>
  `group-${label.toLowerCase().replaceAll(' ', '-')}`

/** Right-side Sessions switcher card for Local projects, Quick chat, and Lark topics. */
export function SessionPanel({
  sessions,
  open,
  activeSessionId,
  subtitle,
  emptyCopy,
  onNewSession,
  onSelect,
  onClose,
}: {
  sessions: Session[]
  open: boolean
  activeSessionId?: string
  subtitle: string
  emptyCopy: string
  onNewSession?: () => void
  onSelect: (sessionId: string) => void
  onClose: () => void
}) {
  const reduced = useReducedMotion()
  const groups = groupSessions(sessions)

  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          className={styles.panel}
          aria-label="Sessions"
          initial={
            reduced ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }
          }
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{
            opacity: 0,
            transition: { duration: velaMotion.duration.quick },
          }}
          transition={
            reduced
              ? { duration: velaMotion.duration.quick }
              : {
                  duration: velaMotion.duration.quick,
                  ease: [...velaMotion.ease.out],
                }
          }
        >
          <header className={styles.head}>
            <div>
              <h2 className={styles.title}>Sessions</h2>
              <p className={styles.subtle}>{subtitle}</p>
            </div>
            <div className={styles.actions}>
              {onNewSession ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="New session in list"
                  onClick={onNewSession}
                >
                  <Plus size={15} aria-hidden="true" />
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Close sessions"
                onClick={onClose}
              >
                <X size={15} aria-hidden="true" />
              </Button>
            </div>
          </header>
          <div className={styles.body}>
            {groups.length === 0 ? (
              <p className={styles.subtle}>{emptyCopy}</p>
            ) : (
              groups.map((group) => (
                <section
                  key={group.label}
                  aria-labelledby={groupHeading(group.label)}
                >
                  <h3 id={groupHeading(group.label)} className={styles.label}>
                    {group.label}
                  </h3>
                  <ul className={styles.list}>
                    {group.sessions.map((session) => (
                      <li key={session.sessionId}>
                        <button
                          type="button"
                          className={styles.row}
                          aria-current={
                            session.sessionId === activeSessionId
                              ? 'true'
                              : undefined
                          }
                          onClick={() => onSelect(session.sessionId)}
                        >
                          <StateMark state={session.state} />
                          <span className={styles.rowTitle}>
                            {session.task || 'New session'}
                          </span>
                          <ChevronRight size={15} aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            )}
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  )
}
