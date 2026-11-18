import type { Project } from '../../shared/bridge.ts'
import { Composer } from '../components/composer.tsx'
import { Conversation } from '../components/conversation.tsx'
import { MessageView } from '../components/message.tsx'
import { projectTimeline } from '../format.ts'
import type { Snapshot } from '../store.ts'
import { send } from '../store.ts'
import styles from './project-page.module.css'
import { SessionCard } from './session-card.tsx'

/** The folder's chat: short questions are answered here, bigger work shows up as a session card. */
export function ProjectPage({
  snapshot,
  project,
}: {
  snapshot: Snapshot
  project: Project
}) {
  if (snapshot.messages[project.sessionId] === undefined)
    return <div className={styles.page} aria-busy="true" />

  const timeline = projectTimeline(snapshot, project)
  return (
    <div className={styles.page}>
      <div className={styles.chat}>
        <Conversation label="Project chat">
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
    </div>
  )
}
