import { Composer } from '../components/composer.tsx'
import { Conversation } from '../components/conversation.tsx'
import { PageError } from '../components/page-error.tsx'
import { quickSessions } from '../format.ts'
import type { Panel } from '../panel.ts'
import styles from '../project/project-page.module.css'
import { SessionPanel } from '../session/session-panel.tsx'
import { SessionView } from '../session/session-view.tsx'
import type { Snapshot } from '../store.ts'
import { createSession, sendInNewLocalSession } from '../store.ts'

/** Projectless Quick chat canvas + session switcher. */
export function QuickChatPage({
  snapshot,
  panel,
  onPanel,
}: {
  snapshot: Snapshot
  panel: Panel
  onPanel: (panel: Panel) => void
}) {
  const sessions = quickSessions(snapshot)
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
          place="quick"
          session={active}
          hint="Quick chat runs without linking a project folder."
          emptyCopy="Start a quick conversation with Vela."
          onDeleted={() => onPanel({ open: panel.open })}
        />
      ) : (
        <div className={styles.chat}>
          <Conversation label="Quick chat" place="quick" centered>
            <p className={styles.empty}>
              Ask Vela anything right away — no project folder required.
            </p>
          </Conversation>
          <div className={styles.composerDock}>
            <Composer
              key="quick-empty"
              label="Quick chat"
              draftKey="quick:empty"
              hint="Quick chat runs without linking a project folder."
              onSend={(text) =>
                sendInNewLocalSession(null, text, (sessionId) =>
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
        subtitle="Chats without a linked folder."
        emptyCopy="No quick chats yet. Start one below or click +."
        onNewSession={() => {
          void createSession(null).then((created) =>
            onPanel({ open: panel.open, sessionId: created.sessionId }),
          )
        }}
        onSelect={(sessionId) => onPanel({ open: panel.open, sessionId })}
        onClose={() => onPanel({ open: false, sessionId: active?.sessionId })}
      />
    </div>
  )
}
