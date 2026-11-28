import { ArrowRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Composer } from '../components/composer.tsx'
import { PageError } from '../components/page-error.tsx'
import {
  defaultHomePick,
  larkStartHint,
  needsYou,
  projectName,
  projectOf,
  projectTag,
  QUICK_PICK,
  recentSessions,
  sessionProjectId,
  stateWord,
} from '../format.ts'
import type { Snapshot } from '../store.ts'
import { startSession } from '../store.ts'
import { Select } from '../ui/select.tsx'
import styles from './home.module.css'

/** Desktop workbench: compact attention & recent sessions above, always-on composer dock below. */
export function Home({
  snapshot,
  focusSignal,
  onOpenProject,
  onOpenQuick,
  onOpenSession,
}: {
  snapshot: Snapshot
  focusSignal: number
  onOpenProject: (projectId: string, sessionId?: string) => void
  onOpenQuick: (sessionId?: string) => void
  onOpenSession: (projectId: string | null, sessionId: string) => void
}) {
  const needs = needsYou(snapshot)
  const recent = recentSessions(snapshot)
  const [picked, setPicked] = useState(() =>
    snapshot.ready ? defaultHomePick(snapshot) : '',
  )
  const picker = useRef<HTMLButtonElement>(null)
  const focusPicker = useRef('')

  useEffect(() => {
    if (!focusPicker.current || focusPicker.current !== picked) return
    focusPicker.current = ''
    picker.current?.focus()
  }, [picked])

  useEffect(() => {
    if (picked || !snapshot.ready) return
    setPicked(defaultHomePick(snapshot))
  }, [picked, snapshot])

  const effectivePick =
    picked || (snapshot.ready ? defaultHomePick(snapshot) : QUICK_PICK)
  const project =
    effectivePick !== QUICK_PICK
      ? snapshot.projects.find((item) => item.id === effectivePick)
      : undefined
  const activePick = project ? project.id : QUICK_PICK

  if (!snapshot.ready) return <div className={styles.page} aria-busy="true" />

  return (
    <div className={styles.page}>
      <div className={styles.scroll}>
        <div className={styles.column}>
          <section className={styles.section} aria-labelledby="needs-you">
            <div className={styles.sectionBar}>
              <h3 id="needs-you" className={styles.label}>
                Needs you
              </h3>
              {needs.length > 0 ? (
                <span className={styles.count}>{needs.length}</span>
              ) : null}
            </div>
            {needs.length === 0 ? (
              <p className={styles.emptyLine}>Nothing needs you right now.</p>
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
                          onOpenSession(
                            sessionProjectId(session),
                            session.sessionId,
                          )
                        }
                      >
                        <span className={styles.glyph} aria-hidden="true">
                          ?
                        </span>
                        <span className={styles.what}>
                          <span className={styles.attentionMeta}>
                            {[
                              'Waiting for you',
                              owner ? projectName(owner) : 'Quick chat',
                              owner ? projectTag(owner) : undefined,
                              session.task || 'New session',
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
                          <ArrowRight size={14} aria-hidden="true" />
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
              <p className={styles.emptyLine}>No sessions yet.</p>
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
                          onOpenSession(
                            sessionProjectId(session),
                            session.sessionId,
                          )
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
                        <span className={styles.rowTitle}>
                          {session.task || 'New session'}
                        </span>
                        <span className={styles.meta}>
                          {owner
                            ? `${projectName(owner)} · ${projectTag(owner)}`
                            : 'Quick chat'}
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
        </div>
      </div>

      <section className={styles.dock} aria-labelledby="start">
        <div className={styles.dockInner}>
          <h3 id="start" className={styles.srOnly}>
            Start a session
          </h3>
          <Composer
            key={activePick}
            label="Message Vela"
            draftKey={`home:${activePick}`}
            focusSignal={focusSignal}
            hint={
              project ? (
                project.channel === 'lark' ? (
                  larkStartHint(projectName(project))
                ) : (
                  <>
                    Runs in <code>{project.cwd}</code> on this computer.
                  </>
                )
              ) : (
                'Starts a quick chat without linking a folder.'
              )
            }
            onSend={(text) =>
              startSession(project ?? 'quick', text, (createdSessionId) => {
                if (project) onOpenProject(project.id, createdSessionId)
                else onOpenQuick(createdSessionId)
              })
            }
          >
            <Select
              compact
              label="Project"
              value={activePick}
              options={[
                { value: QUICK_PICK, label: 'Quick chat' },
                ...snapshot.projects.map((item) => ({
                  value: item.id,
                  label: `${projectName(item)} · ${projectTag(item)}`,
                })),
              ]}
              triggerRef={picker}
              onChange={(next) => {
                if (next === activePick) return
                focusPicker.current = next
                setPicked(next)
              }}
            />
          </Composer>
          {snapshot.error ? (
            <PageError message={snapshot.error} className={styles.error} />
          ) : null}
        </div>
      </section>
    </div>
  )
}
