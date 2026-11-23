import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useState } from 'react'
import type { Project, Session } from '../../shared/bridge.ts'
import { Composer } from '../components/composer.tsx'
import { Conversation } from '../components/conversation.tsx'
import { MessageView } from '../components/message.tsx'
import { PageError } from '../components/page-error.tsx'
import { StateMark } from '../components/state-mark.tsx'
import {
  larkTopicComposer,
  sessionGroups,
  started,
  stateWord,
  visibleMessages,
} from '../format.ts'
import type { Snapshot } from '../store.ts'
import { loadSession, openLarkChat, sendInSession, stop } from '../store.ts'
import { Button } from '../ui/button.tsx'
import { velaMotion } from '../ui/motion.ts'
import styles from './session-panel.module.css'

/**
 * Floating rounded Sessions card anchored to the top-right of the project canvas:
 * compact when showing the session list, taller when inspecting a session conversation.
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
    candidate &&
    candidate.chatId === project.id &&
    candidate.channel === project.channel
      ? candidate
      : undefined
  const detail = Boolean(session && started(session))

  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          className={[styles.panel, detail ? styles.detail : '']
            .filter(Boolean)
            .join(' ')}
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
          {session && started(session) ? (
            <SessionDetail
              key={session.sessionId}
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
  const groups = sessionGroups(snapshot, project)
  const lark = project.channel === 'lark'
  return (
    <>
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>Sessions</h2>
          <p className={styles.subtle}>
            {lark
              ? 'Each one is a topic in the group.'
              : 'Each one runs in this folder.'}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Close sessions"
          onClick={onClose}
        >
          <X size={15} aria-hidden="true" />
        </Button>
      </header>
      <div className={styles.body}>
        {groups.length === 0 ? (
          <p className={styles.subtle}>
            {lark
              ? 'No topics yet. When you start bigger work, Vela opens a topic in the group.'
              : 'No sessions yet. When you ask for bigger work, Vela starts one here.'}
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
                      <ChevronRight size={15} aria-hidden="true" />
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
  // This detail is keyed by session. An in-flight result from a closed topic
  // can only update its old component, never the group or the next topic.
  const [notice, setNotice] = useState('')
  useEffect(() => {
    return loadSession(project.id, session.sessionId, setNotice)
  }, [project.id, session.sessionId])

  const progress = snapshot.progress[session.sessionId]
  const failure = snapshot.failures[session.sessionId]
  const status = snapshot.statuses[session.sessionId]
  const running = session.state === 'running'
  const lark = project.channel === 'lark'
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
            <ChevronLeft size={15} aria-hidden="true" />
            Sessions
          </button>
          <h2 className={styles.title}>{session.task}</h2>
        </div>
        <div className={styles.actions}>
          {running && session.runId ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void stop(session, lark ? setNotice : undefined)}
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
            <X size={15} aria-hidden="true" />
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
      {status ? <p className={styles.subtle}>{status}</p> : null}
      {lark ? (
        <p className={styles.link}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void openLarkChat(project.id, setNotice)}
          >
            <ExternalLink size={16} aria-hidden="true" />
            Open the group in Lark
          </Button>
        </p>
      ) : null}
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
              <MessageView key={message.id} message={message} group={lark} />
            ))}
        </Conversation>
      </div>
      <Composer
        key={session.sessionId}
        label={lark ? 'Message Vela in this topic' : 'Message in this session'}
        draftKey={`session:${session.sessionId}`}
        running={running}
        hint={lark ? larkTopicComposer : undefined}
        onSend={(text) => sendInSession(project, session, text, setNotice)}
      />
      {lark && notice ? (
        <PageError
          message={notice}
          className={styles.notice}
          onDismiss={() => setNotice('')}
        />
      ) : null}
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
