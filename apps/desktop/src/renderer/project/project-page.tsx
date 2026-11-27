import { useEffect } from 'react'
import type { Project } from '../../shared/bridge.ts'
import { Composer } from '../components/composer.tsx'
import { Conversation } from '../components/conversation.tsx'
import { MessageView } from '../components/message.tsx'
import { PageError } from '../components/page-error.tsx'
import {
  larkGroupComposer,
  projectName,
  projectSessions,
  projectTimeline,
} from '../format.ts'
import type { Panel } from '../panel.ts'
import { SessionPanel } from '../session/session-panel.tsx'
import { SessionView } from '../session/session-view.tsx'
import type { Snapshot } from '../store.ts'
import {
  createSession,
  loadEarlierLark,
  sendInNewLocalSession,
  sendInProject,
  watchLarkProject,
} from '../store.ts'
import { Button } from '../ui/button.tsx'
import styles from './project-page.module.css'
import { SessionCard } from './session-card.tsx'

/**
 * Local projects open directly into the active full-width session with a right session list;
 * Lark groups show the group timeline by default and open Topics full-width with Back.
 */
export function ProjectPage({
  snapshot,
  project,
  panel,
  onPanel,
}: {
  snapshot: Snapshot
  project: Project
  panel: Panel
  onPanel: (panel: Panel) => void
}) {
  useEffect(() => watchLarkProject(project), [project])

  if (project.channel === 'local') {
    const sessions = projectSessions(snapshot, project)
    const active =
      (panel.sessionId
        ? sessions.find((s) => s.sessionId === panel.sessionId)
        : undefined) ?? sessions[0]
    return (
      <div className={styles.page}>
        {active ? (
          <SessionView
            key={active.sessionId}
            snapshot={snapshot}
            place={`project:${project.id}`}
            session={active}
            project={project}
            hint={
              <>
                Runs in <code>{project.cwd}</code> on this computer.
              </>
            }
            emptyCopy="Ask Vela about this folder. Replies appear right here."
            onDeleted={() => onPanel({ open: panel.open })}
          />
        ) : (
          <div className={styles.chat}>
            <Conversation
              label="Project chat"
              place={`project:${project.id}`}
              centered
            >
              <p className={styles.empty}>
                Start a session in <code>{project.cwd}</code>.
              </p>
            </Conversation>
            <div className={styles.composerDock}>
              <Composer
                key={project.id}
                label="Message Vela in this project"
                draftKey={`project:${project.id}`}
                hint={
                  <>
                    Runs in <code>{project.cwd}</code> on this computer.
                  </>
                }
                onSend={(text) =>
                  sendInNewLocalSession(project.id, text, (sessionId) =>
                    onPanel({ open: panel.open, sessionId }),
                  )
                }
              />
              {snapshot.error ? (
                <PageError message={snapshot.error} className={styles.error} />
              ) : null}
            </div>
          </div>
        )}
        <SessionPanel
          sessions={sessions}
          open={panel.open}
          activeSessionId={active?.sessionId}
          subtitle="Each one runs in this folder."
          emptyCopy="No sessions yet. Start one below or click +."
          onNewSession={() => {
            void createSession(project.id).then((created) =>
              onPanel({ open: panel.open, sessionId: created.sessionId }),
            )
          }}
          onSelect={(sessionId) => onPanel({ open: panel.open, sessionId })}
          onClose={() => onPanel({ open: false, sessionId: active?.sessionId })}
        />
      </div>
    )
  }

  if (snapshot.connections.lark?.connected === false) {
    return <LarkOff snapshot={snapshot} project={project} />
  }

  const topics = projectSessions(snapshot, project)
  const activeTopic = panel.sessionId
    ? topics.find((s) => s.sessionId === panel.sessionId)
    : undefined

  if (activeTopic) {
    return (
      <div className={styles.page}>
        <SessionView
          key={activeTopic.sessionId}
          snapshot={snapshot}
          place={`project:${project.id}`}
          session={activeTopic}
          project={project}
          onBack={() => onPanel({ open: panel.open })}
        />
        <SessionPanel
          sessions={topics}
          open={panel.open}
          activeSessionId={activeTopic.sessionId}
          subtitle="Each one is a topic in the group."
          emptyCopy="No topics yet. When you start bigger work, Vela opens a topic in the group."
          onSelect={(sessionId) => onPanel({ open: panel.open, sessionId })}
          onClose={() => onPanel({ open: false, sessionId: panel.sessionId })}
        />
      </div>
    )
  }

  if (snapshot.messages[project.sessionId] === undefined) {
    return <div className={styles.page} aria-busy="true" />
  }

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
              Ask Vela a short question here. It posts in the group as the bot;
              bigger work opens a topic.
            </p>
          ) : (
            timeline.map((item) =>
              item.kind === 'message' ? (
                <MessageView
                  key={item.message.id}
                  message={item.message}
                  group
                />
              ) : (
                <SessionCard
                  key={item.session.sessionId}
                  session={item.session}
                  onOpen={() =>
                    onPanel({
                      open: panel.open,
                      sessionId: item.session.sessionId,
                    })
                  }
                />
              ),
            )
          )}
        </Conversation>
        <div className={styles.composerDock}>
          <Composer
            key={project.id}
            label="Message Vela in this group"
            draftKey={`project:${project.id}`}
            hint={larkGroupComposer}
            onSend={(text) => sendInProject(project, text)}
          />
          {snapshot.error ? (
            <PageError message={snapshot.error} className={styles.error} />
          ) : null}
        </div>
      </div>
      <SessionPanel
        sessions={topics}
        open={panel.open}
        subtitle="Each one is a topic in the group."
        emptyCopy="No topics yet. When you start bigger work, Vela opens a topic in the group."
        onSelect={(sessionId) => onPanel({ open: panel.open, sessionId })}
        onClose={() => onPanel({ open: false, sessionId: panel.sessionId })}
      />
    </div>
  )
}

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
