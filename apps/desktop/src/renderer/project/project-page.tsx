import { useEffect } from 'react'
import type { Project } from '../../shared/bridge.ts'
import { Composer } from '../components/composer.tsx'
import { Conversation } from '../components/conversation.tsx'
import { MessageView } from '../components/message.tsx'
import { PageError } from '../components/page-error.tsx'
import { larkGroupComposer, projectName, projectTimeline } from '../format.ts'
import type { Panel } from '../panel.ts'
import { SessionPanel } from '../session/session-panel.tsx'
import type { Snapshot } from '../store.ts'
import { loadEarlierLark, sendInProject, watchLarkProject } from '../store.ts'
import { Button } from '../ui/button.tsx'
import styles from './project-page.module.css'
import { SessionCard } from './session-card.tsx'

/** The project chat: short questions are answered here, bigger work shows up as a session card. */
export function ProjectPage({
  snapshot,
  project,
  panel,
  onPanel,
}: {
  snapshot: Snapshot
  project: Project
  /** The panel and the session it shows; undefined session means its list. */
  panel: Panel
  onPanel: (panel: Panel) => void
}) {
  useEffect(() => watchLarkProject(project), [project])
  const lark = project.channel === 'lark'
  if (lark && snapshot.connections.lark?.connected === false)
    return <LarkOff snapshot={snapshot} project={project} />
  if (snapshot.messages[project.sessionId] === undefined)
    return <div className={styles.page} aria-busy="true" />

  const timeline = projectTimeline(snapshot, project)
  const earlier = snapshot.earlier[project.sessionId] === true
  return (
    <div className={styles.page}>
      <div className={styles.chat}>
        <Conversation
          label="Project chat"
          place={`project:${project.id}`}
          centered
        >
          {earlier ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => loadEarlierLark(project)}
            >
              Show earlier messages
            </Button>
          ) : null}
          {timeline.length === 0 ? (
            <p className={styles.empty}>
              {lark
                ? 'Ask Vela a short question here. It posts in the group as the bot; bigger work opens a topic.'
                : 'Ask Vela about this folder. Short questions are answered here; bigger work starts a session.'}
            </p>
          ) : (
            timeline.map((item) =>
              item.kind === 'message' ? (
                <MessageView
                  key={item.message.id}
                  message={item.message}
                  group={lark}
                />
              ) : (
                <SessionCard
                  key={item.session.sessionId}
                  session={item.session}
                  onOpen={() =>
                    onPanel({ open: true, sessionId: item.session.sessionId })
                  }
                />
              ),
            )
          )}
        </Conversation>
        <div className={styles.composerDock}>
          <Composer
            key={project.id}
            label={
              lark
                ? 'Message Vela in this group'
                : 'Message Vela in this project'
            }
            draftKey={`project:${project.id}`}
            hint={
              lark ? (
                larkGroupComposer
              ) : (
                <>
                  Runs in <code>{project.cwd}</code> on this computer.
                </>
              )
            }
            onSend={(text) => sendInProject(project, text)}
          />
          {snapshot.error ? (
            <PageError message={snapshot.error} className={styles.error} />
          ) : null}
        </div>
      </div>
      <SessionPanel
        snapshot={snapshot}
        project={project}
        open={panel.open}
        sessionId={panel.sessionId}
        onOpen={(sessionId) =>
          onPanel({ open: true, ...(sessionId ? { sessionId } : {}) })
        }
        onClose={() => onPanel({ open: false, sessionId: panel.sessionId })}
      />
    </div>
  )
}

/** A Lark project while its connection is down: no reads, no sends, Local keeps working. */
function LarkOff({
  snapshot,
  project,
}: {
  snapshot: Snapshot
  project: Project
}) {
  const error = snapshot.connections.lark?.error
  return (
    <div className={styles.page}>
      <div className={styles.chat}>
        <section className={styles.empty} role="status">
          <h2 className={styles.offTitle}>Lark is off.</h2>
          <p>
            {projectName(project)} is a Lark group, and this app cannot reach
            Lark right now, so it does not read the group or its topics. Local
            projects keep working.
          </p>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
        </section>
      </div>
    </div>
  )
}
