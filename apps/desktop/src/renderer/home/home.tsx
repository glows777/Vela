import { useState } from 'react'
import { Composer } from '../components/composer.tsx'
import { StateMark } from '../components/state-mark.tsx'
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
}: {
  snapshot: Snapshot
  focusSignal: number
  onOpenProject: (projectId: string) => void
}) {
  const needs = needsYou(snapshot)
  const recent = recentSessions(snapshot)
  const [picked, setPicked] = useState('')
  const project =
    snapshot.projects.find((item) => item.id === picked) ??
    lastUsedProject(snapshot)

  if (!snapshot.ready) return <div className={styles.page} aria-busy="true" />

  return (
    <div className={styles.page}>
      <div className={styles.column}>
        <section className={styles.section} aria-labelledby="needs-you">
          <h2 id="needs-you" className={styles.label}>
            Needs you
          </h2>
          {needs.length === 0 ? (
            <p className={styles.note}>Nothing needs you right now.</p>
          ) : (
            <ul className={styles.list}>
              {needs.map((session) => {
                const owner = projectOf(snapshot, session)
                return (
                  <li key={session.sessionId}>
                    <button
                      type="button"
                      className={styles.need}
                      onClick={() => onOpenProject(session.chatId)}
                    >
                      <span className={styles.needLabel}>
                        <StateMark state="waiting" />
                        Waiting for you
                      </span>
                      <span className={styles.question}>
                        {session.waitingReason}
                      </span>
                      <span className={styles.meta}>
                        {[session.task, owner?.name, 'Local']
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className={styles.section} aria-labelledby="recent">
          <h2 id="recent" className={styles.label}>
            Recent sessions
          </h2>
          {recent.length === 0 ? (
            <p className={styles.note}>No sessions yet.</p>
          ) : (
            <ul className={styles.list}>
              {recent.map((session) => {
                const owner = projectOf(snapshot, session)
                return (
                  <li key={session.sessionId}>
                    <button
                      type="button"
                      className={styles.row}
                      onClick={() => onOpenProject(session.chatId)}
                    >
                      <StateMark state={session.state} />
                      <span className={styles.rowTitle}>{session.task}</span>
                      <span className={styles.meta}>
                        {owner ? `${owner.name} · Local` : 'Local'}
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
          <h2 id="start" className={styles.label}>
            Start a session
          </h2>
          {project ? (
            <Composer
              label="Message Vela"
              focusSignal={focusSignal}
              hint={
                <>
                  Runs in <code>{project.cwd}</code> on this computer.
                </>
              }
              onSend={(text) => void send(project.id, project.sessionId, text)}
            >
              <label className={styles.picker}>
                <span>Project</span>
                <select
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
              </label>
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
