import type { Project } from '../../shared/bridge.ts'
import { Composer } from '../components/composer.tsx'
import { Conversation } from '../components/conversation.tsx'
import { MessageView } from '../components/message.tsx'
import { projectTimeline } from '../format.ts'
import type { Panel } from '../panel.ts'
import { SessionPanel } from '../session/session-panel.tsx'
import type { Snapshot } from '../store.ts'
import { send } from '../store.ts'
import styles from './project-page.module.css'
import { SessionCard } from './session-card.tsx'

/** The folder's chat: short questions are answered here, bigger work shows up as a session card. */
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
  if (snapshot.messages[project.sessionId] === undefined)
    return <div className={styles.page} aria-busy="true" />

  const timeline = projectTimeline(snapshot, project)
  return (
    <div className={styles.page}>
      <div className={styles.chat}>
        <Conversation label="Project chat" place={`project:${project.id}`}>
          {timeline.length === 0 ? (
            <p className={styles.empty}>
              Ask Vela about this folder. Short questions are answered here;
              bigger work starts a session.
            </p>
          ) : (
            timeline.map((item) =>
              item.kind === 'message' ? (
                <MessageView key={item.message.id} message={item.message} />
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
        <Composer
          label="Message Vela in this project"
          hint={
            <>
              Runs in <code>{project.cwd}</code> on this computer.
            </>
          }
          onSend={(text) => send(project.id, project.sessionId, text)}
        />
        {snapshot.error ? (
          <p className={styles.error} role="alert">
            {snapshot.error}
          </p>
        ) : null}
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
