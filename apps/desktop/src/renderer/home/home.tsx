import { ArrowRight, ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Composer } from '../components/composer.tsx'
import {
  lastUsedProject,
  needsYou,
  projectOf,
  recentSessions,
  stateWord,
} from '../format.ts'
import type { Snapshot } from '../store.ts'
import { send } from '../store.ts'
import styles from './home.module.css'

/** What needs you, then recent sessions, then the composer that starts work in a project. */
export function Home({
  snapshot,
  focusSignal,
  onOpenProject,
  onOpenSession,
}: {
  snapshot: Snapshot
  focusSignal: number
  onOpenProject: (projectId: string) => void
  onOpenSession: (projectId: string, sessionId: string) => void
}) {
  const needs = needsYou(snapshot)
  const recent = recentSessions(snapshot)
  const [picked, setPicked] = useState('')

  // Latch the suggested project once: later activity must not move the destination
  // while the person is typing.
  useEffect(() => {
    if (picked || !snapshot.ready) return
    const suggestion = lastUsedProject(snapshot)
    if (suggestion) setPicked(suggestion.id)
  }, [picked, snapshot])

  const project = snapshot.projects.find((item) => item.id === picked)
  const headline =
    needs.length === 1
      ? 'One session needs you.'
      : needs.length > 1
        ? `${needs.length} sessions need you.`
        : 'Give Vela a task.'

  if (!snapshot.ready) return <div className={styles.page} aria-busy="true" />

  return (
    <div className={styles.page}>
      <div className={styles.column}>
        <div className={styles.hero}>
          <span className={styles.signal} aria-hidden="true" />
          <h2 className={styles.headline}>{headline}</h2>
        </div>

        <section className={styles.section} aria-labelledby="needs-you">
          <h3 id="needs-you" className={styles.label}>
            Needs you
          </h3>
          {needs.length === 0 ? (
            <p className={styles.note}>Nothing needs you right now.</p>
          ) : (
            <ul className={styles.attentionList}>
              {needs.map((session) => {
                const owner = projectOf(snapshot, session)
                return (
                  <li key={session.sessionId}>
                    <button
                      type="button"
                      className={styles.attention}
                      onClick={() =>
                        onOpenSession(session.chatId, session.sessionId)
                      }
                    >
                      <span className={styles.glyph} aria-hidden="true">
                        ?
                      </span>
                      <span className={styles.what}>
                        <span className={styles.attentionMeta}>
                          {[
                            'Waiting for you',
                            owner?.name,
                            'Local',
                            session.task,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                        <span className={styles.question}>
                          {session.waitingReason}
                        </span>
                      </span>
                      <span className={styles.go}>
                        Open
                        <ArrowRight size={16} aria-hidden="true" />
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className={styles.section} aria-labelledby="recent">
          <h3 id="recent" className={styles.label}>
            Recent sessions
          </h3>
          {recent.length === 0 ? (
            <p className={styles.note}>No sessions yet.</p>
          ) : (
            <ul className={styles.listCard}>
              {recent.map((session) => {
                const owner = projectOf(snapshot, session)
                return (
                  <li key={session.sessionId} className={styles.listItem}>
                    <button
                      type="button"
                      className={styles.row}
                      onClick={() =>
                        onOpenSession(session.chatId, session.sessionId)
                      }
                    >
                      <span
                        className={[
                          styles.dot,
                          session.state === 'waiting'
                            ? styles.dotWaiting
                            : session.state === 'running'
                              ? styles.dotRunning
                              : styles.dotIdle,
                        ].join(' ')}
                        aria-hidden="true"
                      />
                      <span className={styles.rowBody}>
                        <span className={styles.rowTitle}>{session.task}</span>
                        <span className={styles.meta}>
                          {[
                            owner?.name,
                            'Local',
                            stateWord[session.state],
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      <span className={styles.word}>
                        {stateWord[session.state]}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className={styles.section} aria-labelledby="start">
          <h3 id="start" className={styles.label}>
            Start a session
          </h3>
          {project ? (
            <Composer
              key={project.id}
              label="Message Vela"
              draftKey={`home:${project.id}`}
              focusSignal={focusSignal}
              hint={
                <>
                  Runs in <code>{project.cwd}</code> on this computer.
                </>
              }
              onSend={async (text) => {
                const accepted = await send(project.id, project.sessionId, text)
                if (accepted) onOpenProject(project.id)
                return accepted
              }}
            >
              <div className={styles.pickerWrap}>
                <span className={styles.pickerDot} aria-hidden="true" />
                <select
                  className={styles.picker}
                  aria-label="Project"
                  value={project.id}
                  onChange={(event) => setPicked(event.target.value)}
                >
                  {snapshot.projects.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  className={styles.pickerChevron}
                  size={14}
                  aria-hidden="true"
                />
              </div>
            </Composer>
          ) : (
            <p className={styles.note}>
              Create a project to start a session in a folder.
            </p>
          )}
          {snapshot.error ? (
            <p className={styles.error} role="alert">
              {snapshot.error}
            </p>
          ) : null}
        </section>
      </div>
    </div>
  )
}
