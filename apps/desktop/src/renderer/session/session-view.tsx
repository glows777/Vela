import { ArrowLeft, ExternalLink, Pencil, Trash2 } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { Project, Session } from '../../shared/bridge.ts'
import { Composer } from '../components/composer.tsx'
import { Conversation } from '../components/conversation.tsx'
import { MessageView } from '../components/message.tsx'
import { PageError } from '../components/page-error.tsx'
import { StateMark } from '../components/state-mark.tsx'
import { larkTopicComposer, stateWord, visibleMessages } from '../format.ts'
import type { Snapshot } from '../store.ts'
import {
  deleteSession,
  dismissPageError,
  loadSession,
  openLarkChat,
  renameSession,
  sendInNewLocalSession,
  sendInSession,
  stop,
} from '../store.ts'
import { Button } from '../ui/button.tsx'
import { ConfirmDialog } from '../ui/confirm-dialog.tsx'
import { currentStage } from './progress.ts'
import styles from './session-view.module.css'

/** Full-width centered 720px conversation view for Local sessions, Quick chat, and Lark topics. */
export function SessionView({
  snapshot,
  place,
  session,
  project,
  hint,
  emptyCopy,
  onBack,
  onSessionCreated,
  onDeleted,
}: {
  snapshot: Snapshot
  place: string
  session: Session
  project?: Project
  hint?: ReactNode
  emptyCopy?: string
  onBack?: () => void
  onSessionCreated?: (sessionId: string) => void
  onDeleted?: () => void
}) {
  const [notice, setNotice] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(session.task)
  const [confirmDelete, setConfirmDelete] = useState<HTMLButtonElement>()
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) renameInputRef.current?.focus()
  }, [renaming])

  useEffect(() => {
    setDraftName(session.task)
  }, [session.task])

  useEffect(() => {
    return loadSession(place, session.sessionId, setNotice)
  }, [place, session.sessionId])

  const lark = session.channel === 'lark'
  const running = session.state === 'running'
  const stage = running
    ? currentStage(snapshot.progress[session.sessionId])
    : undefined
  const failure = snapshot.failures[session.sessionId]
  const status = snapshot.statuses[session.sessionId]
  const messages = visibleMessages(snapshot, session.sessionId).filter(
    (message) => !(message.role === 'system' && message.text === session.task),
  )

  const commitRename = async () => {
    const trimmed = draftName.trim()
    setRenaming(false)
    if (!trimmed || trimmed === session.task) return
    try {
      await renameSession(session.sessionId, trimmed)
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.topbar}>
        <div className={styles.left}>
          {onBack ? (
            <button type="button" className={styles.back} onClick={onBack}>
              <ArrowLeft size={14} aria-hidden="true" />
              Back to group chat
            </button>
          ) : null}
          {renaming ? (
            <form
              className={styles.renameForm}
              onSubmit={(event) => {
                event.preventDefault()
                void commitRename()
              }}
            >
              <input
                ref={renameInputRef}
                type="text"
                aria-label="Session name"
                className={styles.renameInput}
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setRenaming(false)
                    setDraftName(session.task)
                  }
                }}
              />
              <Button type="submit" size="sm" variant="secondary">
                Save
              </Button>
            </form>
          ) : (
            <h3 className={styles.title}>{session.task || 'New session'}</h3>
          )}
          <p className={styles.state}>
            <StateMark state={session.state} />
            <span>{stateWord[session.state]}</span>
            {stage ? <span className={styles.progress}>{stage}</span> : null}
          </p>
        </div>
        <div className={styles.right}>
          {lark && project ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void openLarkChat(project.id, setNotice)}
            >
              <ExternalLink size={14} aria-hidden="true" />
              Open the group in Lark
            </Button>
          ) : null}
          {!lark && !renaming ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Rename session"
                onClick={() => {
                  setDraftName(session.task)
                  setRenaming(true)
                }}
              >
                <Pencil size={14} aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Delete session"
                onClick={(event) => setConfirmDelete(event.currentTarget)}
              >
                <Trash2 size={14} aria-hidden="true" />
              </Button>
            </>
          ) : null}
          {running && session.runId ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void stop(session, lark ? setNotice : undefined)}
            >
              Stop
            </Button>
          ) : null}
        </div>
      </div>
      {status ? <p className={styles.subtle}>{status}</p> : null}
      <Conversation
        label="Session messages"
        place={`session:${session.sessionId}`}
        centered
      >
        {failure ? <ErrorCard message={failure.message} /> : null}
        {messages.length === 0 ? (
          <p className={styles.empty}>
            {emptyCopy ??
              'Ask Vela anything here. Your conversation stays in this session.'}
          </p>
        ) : (
          messages.map((message) => (
            <MessageView key={message.id} message={message} group={lark} />
          ))
        )}
      </Conversation>
      <div className={styles.composerDock}>
        <Composer
          key={session.sessionId}
          label={
            lark
              ? 'Message Vela in this topic'
              : session.isHub
                ? 'Message Vela in a new session'
                : 'Message Vela'
          }
          draftKey={`session:${session.sessionId}`}
          running={running}
          hint={lark ? larkTopicComposer : hint}
          onSend={(text) => {
            setNotice('')
            if (session.isHub && !lark) {
              return sendInNewLocalSession(
                session.projectId,
                text,
                (sessionId) => onSessionCreated?.(sessionId),
                setNotice,
              )
            }
            return sendInSession(project, session, text, setNotice)
          }}
        />
        {(lark ? notice : snapshot.error || notice) ? (
          <PageError
            message={lark ? notice : snapshot.error || notice}
            className={styles.notice}
            onDismiss={() => {
              setNotice('')
              if (!lark) dismissPageError()
            }}
          />
        ) : null}
      </div>
      {confirmDelete ? (
        <ConfirmDialog
          title="Delete session"
          description={`Delete “${session.task || 'this session'}”? Its messages will be removed.`}
          trigger={confirmDelete}
          onCancel={() => setConfirmDelete(undefined)}
          onConfirm={() => {
            setConfirmDelete(undefined)
            void deleteSession(
              session.sessionId,
              lark ? setNotice : undefined,
            ).then((ok) => {
              if (ok) onDeleted?.()
            })
          }}
        />
      ) : null}
    </div>
  )
}

function ErrorCard({ message }: { message: string }) {
  return (
    <section className={styles.errorCard} role="alert">
      <h3 className={styles.errorTitle}>Vela stopped on an error.</h3>
      <p className={styles.errorText}>
        Nothing after this point ran, and the session is saved.
      </p>
      <pre className={styles.raw}>{message}</pre>
    </section>
  )
}
