import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect } from 'react'
import type { Project, Session } from '../../shared/bridge.ts'
import { Button } from '../ui/button.tsx'
import { velaMotion } from '../ui/motion.ts'
import { Composer } from '../components/composer.tsx'
import { Conversation } from '../components/conversation.tsx'
import { MessageView } from '../components/message.tsx'
import { StateMark } from '../components/state-mark.tsx'
import {
  sessionGroups,
  started,
  stateWord,
  visibleMessages,
} from '../format.ts'
import type { Snapshot } from '../store.ts'
import { loadSession, send, stop } from '../store.ts'
import styles from './session-panel.module.css'

/**
 * The 480px panel on the right of a project: the session list at its root, and one
 * session's conversation when opened. Never a page of its own, so the chat stays in view.
 */
export function SessionPanel({
  snapshot,
  project,
  open,
  sessionId,
  onOpen,
  onClose,
}: {
  snapshot: Snapshot
  project: Project
  open: boolean
  sessionId?: string
  onOpen: (sessionId?: string) => void
  onClose: () => void
}) {
  const reduced = useReducedMotion()
  const candidate = sessionId ? snapshot.sessions[sessionId] : undefined
  // A session belongs to the project whose chat started it.
  const session =
    candidate && candidate.chatId === project.id ? candidate : undefined
  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          className={styles.panel}
          aria-label="Sessions"
          initial={reduced ? { opacity: 0 } : { opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{
            opacity: 0,
            transition: { duration: velaMotion.duration.quick },
          }}
          transition={
            reduced
              ? { duration: velaMotion.duration.base }
              : {
                  duration: velaMotion.duration.base,
                  ease: [...velaMotion.ease.out],
                }
          }
        >
          {session && started(session) ? (
            <SessionDetail
              snapshot={snapshot}
              project={project}
              session={session}
              onBack={() => onOpen()}
              onClose={onClose}
            />
          ) : (
            <SessionList
              snapshot={snapshot}
              project={project}
              onSelect={onOpen}
              onClose={onClose}
            />
          )}
        </motion.aside>
      ) : null}
    </AnimatePresence>
  )
}

function SessionList({
  snapshot,
  project,
  onSelect,
  onClose,
}: {
  snapshot: Snapshot
  project: Project
  onSelect: (sessionId?: string) => void
  onClose: () => void
}) {
  const groups = sessionGroups(snapshot, project.id)
  return (
    <>
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>Sessions</h2>
          <p className={styles.subtle}>Each one runs in this folder.</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Close sessions"
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </Button>
      </header>
      <div className={styles.body}>
        {groups.length === 0 ? (
          <p className={styles.subtle}>
            No sessions yet. When you ask for bigger work, Vela starts one here.
          </p>
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
                      onClick={() => onSelect(session.sessionId)}
                    >
                      <StateMark state={session.state} />
                      <span className={styles.rowTitle}>{session.task}</span>
                      <ChevronRight size={16} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </>
  )
}

function SessionDetail({
  snapshot,
  project,
  session,
  onBack,
  onClose,
}: {
  snapshot: Snapshot
  project: Project
  session: Session
  onBack: () => void
  onClose: () => void
}) {
  useEffect(() => {
    loadSession(project.id, session.sessionId)
  }, [project.id, session.sessionId])

  const progress = snapshot.progress[session.sessionId]
  const failure = snapshot.failures[session.sessionId]
  const running = session.state === 'running'
  return (
    <>
      <header className={styles.head}>
        <div className={styles.path}>
          <button
            type="button"
            className={styles.crumb}
            onClick={onBack}
            aria-label="All sessions"
          >
            <ChevronLeft size={16} aria-hidden="true" />
            Sessions
          </button>
          <h2 className={styles.title}>{session.task}</h2>
        </div>
        <div className={styles.actions}>
          {running && session.runId ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void stop(session)}
            >
              Stop
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            aria-label="Close sessions"
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
      </header>
      <p className={styles.state}>
        <StateMark state={session.state} />
        <span>{stateWord[session.state]}</span>
        {running && progress?.stage === 'tool' ? (
          <span className={styles.progress}>{progress.tool}</span>
        ) : null}
        {running && progress?.stage === 'retry' ? (
          <span className={styles.progress}>Retrying</span>
        ) : null}
      </p>
      <div className={styles.body}>
        {failure ? <ErrorCard message={failure.message} /> : null}
        <Conversation
          label="Session messages"
          place={`session:${session.sessionId}`}
        >
          {visibleMessages(snapshot, session.sessionId)
            .filter(
              (message) =>
                !(message.role === 'system' && message.text === session.task),
            )
            .map((message) => (
              <MessageView key={message.id} message={message} />
            ))}
        </Conversation>
      </div>
      <Composer
        key={session.sessionId}
        label="Message in this session"
        draftKey={`session:${session.sessionId}`}
        running={running}
        onSend={(text) => send(project.id, session.sessionId, text)}
      />
    </>
  )
}

/** An id safe for aria-labelledby, which splits on spaces. */
const groupHeading = (label: string) =>
  `group-${label.toLowerCase().replaceAll(' ', '-')}`

/** One card for a failed run; the reply it wrote is hidden while it is shown. */
function ErrorCard({ message }: { message: string }) {
  return (
    <section className={styles.error} role="alert">
      <h3 className={styles.errorTitle}>Vela stopped on an error.</h3>
      <p className={styles.errorText}>
        Nothing after this point ran, and the session is saved.
      </p>
      <pre className={styles.raw}>{message}</pre>
    </section>
  )
}
