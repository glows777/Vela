import { useCallback, useEffect, useState } from 'react'
import styles from './app.module.css'
import { needsYou, sessionProjectId } from './format.ts'
import { HeaderBar } from './frame/header-bar.tsx'
import { NewProjectDialog } from './frame/new-project.tsx'
import { Sidebar } from './frame/sidebar.tsx'
import { Wordmark } from './frame/wordmark.tsx'
import { Home } from './home/home.tsx'
import type { Panel } from './panel.ts'
import { ProjectPage } from './project/project-page.tsx'
import { QuickChatPage } from './quick/quick-page.tsx'
import { RoutinesPage } from './routines/routines-page.tsx'
import { SettingsPage } from './settings/settings-page.tsx'
import { FirstRun } from './setup/first-run.tsx'
import {
  loadProject,
  loadQuickChats,
  removeProject,
  setErrorView,
  start,
  useStore,
} from './store.ts'

const isMac = navigator.platform.startsWith('Mac')

type View =
  | { name: 'home' }
  | { name: 'quick' }
  | { name: 'routines' }
  | { name: 'settings' }
  | { name: 'project'; projectId: string }

/** The frame: a fixed sidebar and header bar around Home, Quick chat, or one project. */
export function App() {
  const snapshot = useStore()
  const [view, setView] = useState<View>({ name: 'home' })
  const [creating, setCreating] = useState(false)
  const [focusSignal, setFocusSignal] = useState(0)
  const [panel, setPanel] = useState<Panel>({ open: true })

  useEffect(() => {
    void start()
  }, [])

  const navigate = useCallback((next: View) => {
    setErrorView(
      next.name === 'project' ? `project:${next.projectId}` : next.name,
    )
    setView(next)
  }, [])

  const newSession = useCallback(() => {
    navigate({ name: 'home' })
    setFocusSignal((value) => value + 1)
  }, [navigate])

  const ready = snapshot.settings?.setup.required === false
  useEffect(() => {
    if (!ready) return
    const onShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.key.toLowerCase() !== 'n' ||
        event.altKey ||
        event.shiftKey ||
        event.metaKey !== isMac ||
        event.ctrlKey === isMac ||
        document.querySelector('[role="dialog"][data-state="open"]')
      )
        return
      event.preventDefault()
      newSession()
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [ready, newSession])

  const project =
    view.name === 'project'
      ? snapshot.projects.find((item) => item.id === view.projectId)
      : undefined

  useEffect(() => {
    if (snapshot.ready && view.name === 'project' && !project) {
      navigate({ name: 'home' })
    }
  }, [snapshot.ready, view.name, project, navigate])

  const openProjectPage = (projectId: string, sessionId?: string) => {
    navigate({ name: 'project', projectId })
    setPanel(sessionId ? { open: true, sessionId } : { open: panel.open })
    void loadProject(projectId)
  }

  const openQuickChat = (sessionId?: string) => {
    navigate({ name: 'quick' })
    setPanel(sessionId ? { open: true, sessionId } : { open: panel.open })
    void loadQuickChats()
  }

  const openSession = (projectId: string | null, sessionId: string) => {
    if (!projectId) {
      openQuickChat(sessionId)
      return
    }
    openProjectPage(projectId, sessionId)
  }

  const waiting = project
    ? needsYou(snapshot).some(
        (session) =>
          sessionProjectId(session) === project.id &&
          session.channel === project.channel,
      )
    : view.name === 'quick'
      ? needsYou(snapshot).some((session) => session.chatKind === 'quick')
      : false

  if (!snapshot.settings)
    return snapshot.error ? (
      <main className={styles.hostError}>
        <Wordmark heading />
        <p role="alert">{snapshot.error}</p>
        <p className={styles.hint}>
          Fix that file and restart Vela. Settings › General shows the folder
          once it opens.
        </p>
      </main>
    ) : (
      <div className={styles.booting} aria-busy="true" />
    )
  if (snapshot.settings.setup.required)
    return <FirstRun settings={snapshot.settings} />

  const hasSessionsRail = Boolean(project) || view.name === 'quick'

  return (
    <div className={styles.app}>
      <Sidebar
        projects={snapshot.projects}
        connections={snapshot.connections}
        current={view.name === 'project' ? view.projectId : view.name}
        onHome={() => navigate({ name: 'home' })}
        onQuick={() => openQuickChat()}
        onRoutines={() => navigate({ name: 'routines' })}
        onProject={openProjectPage}
        onSettings={() => navigate({ name: 'settings' })}
        newSessionShortcut={isMac ? '⌘N' : 'Ctrl+N'}
        onNewSession={newSession}
        onNewProject={() => setCreating(true)}
      />
      <div className={styles.main}>
        <HeaderBar
          project={project}
          title={
            view.name === 'quick'
              ? 'Quick chat'
              : view.name === 'routines'
                ? 'Routines'
                : view.name === 'settings'
                  ? 'Settings'
                  : undefined
          }
          waiting={waiting}
          panelOpen={hasSessionsRail ? panel.open : undefined}
          onTogglePanel={
            hasSessionsRail
              ? () => setPanel((cur) => ({ ...cur, open: !cur.open }))
              : undefined
          }
          onRemoveProject={
            project?.channel === 'local'
              ? () => {
                  void removeProject(project.id).then((removed) => {
                    if (removed) navigate({ name: 'home' })
                  })
                }
              : undefined
          }
        />
        <main className={styles.content}>
          {view.name === 'routines' ? (
            <RoutinesPage snapshot={snapshot} />
          ) : view.name === 'settings' ? (
            <SettingsPage settings={snapshot.settings} />
          ) : view.name === 'quick' ? (
            <QuickChatPage
              snapshot={snapshot}
              panel={panel}
              onPanel={setPanel}
            />
          ) : project ? (
            <ProjectPage
              snapshot={snapshot}
              project={project}
              panel={panel}
              onPanel={setPanel}
            />
          ) : (
            <Home
              snapshot={snapshot}
              focusSignal={focusSignal}
              onOpenProject={openProjectPage}
              onOpenQuick={openQuickChat}
              onOpenSession={openSession}
            />
          )}
        </main>
      </div>
      <NewProjectDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(created) => openProjectPage(created.id)}
      />
    </div>
  )
}
