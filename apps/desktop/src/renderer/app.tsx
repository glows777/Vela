import { useEffect, useState } from 'react'
import styles from './app.module.css'
import { needsYou } from './format.ts'
import { HeaderBar } from './frame/header-bar.tsx'
import { NewProjectDialog } from './frame/new-project.tsx'
import { Sidebar } from './frame/sidebar.tsx'
import { Wordmark } from './frame/wordmark.tsx'
import { Home } from './home/home.tsx'
import type { Panel } from './panel.ts'
import { ProjectPage } from './project/project-page.tsx'
import { RoutinesPage } from './routines/routines-page.tsx'
import { SettingsPage } from './settings/settings-page.tsx'
import { FirstRun } from './setup/first-run.tsx'
import { loadProject, start, useStore } from './store.ts'

type View =
  | { name: 'home' }
  | { name: 'routines' }
  | { name: 'settings' }
  | { name: 'project'; projectId: string }

/** The frame: a fixed sidebar and header bar around Home or one project. */
export function App() {
  const snapshot = useStore()
  const [view, setView] = useState<View>({ name: 'home' })
  const [creating, setCreating] = useState(false)
  const [focusSignal, setFocusSignal] = useState(0)
  const [panel, setPanel] = useState<Panel>({ open: true })

  useEffect(() => {
    void start()
  }, [])

  const project =
    view.name === 'project'
      ? snapshot.projects.find((item) => item.id === view.projectId)
      : undefined

  /**
   * Every way into a project goes through here, so the panel never keeps a session
   * from the project the person just left. Sidebar, Home, a session card and a new
   * project all land on the same state. A closed panel stays closed when the person
   * only picks a project, and opens when the destination is a session.
   */
  const openProjectPage = (projectId: string, sessionId?: string) => {
    setView({ name: 'project', projectId })
    setPanel(sessionId ? { open: true, sessionId } : { open: panel.open })
    void loadProject(projectId)
  }

  const openSession = (projectId: string, sessionId: string) =>
    openProjectPage(projectId, sessionId)

  const waiting = project
    ? needsYou(snapshot).some((session) => session.chatId === project.id)
    : false

  // A read that fails is a reason, not a blank window: nothing else renders while settings is
  // missing, so the error is all the person can be shown.
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

  return (
    <div className={styles.app}>
      <Sidebar
        projects={snapshot.projects}
        current={view.name === 'project' ? view.projectId : view.name}
        onHome={() => setView({ name: 'home' })}
        onRoutines={() => setView({ name: 'routines' })}
        onProject={openProjectPage}
        onSettings={() => setView({ name: 'settings' })}
        onNewSession={() => {
          setView({ name: 'home' })
          setFocusSignal((value) => value + 1)
        }}
        onNewProject={() => setCreating(true)}
      />
      <div className={styles.main}>
        <HeaderBar
          project={project}
          title={
            view.name === 'routines'
              ? 'Routines'
              : view.name === 'settings'
                ? 'Settings'
                : undefined
          }
          waiting={waiting}
        />
        <main className={styles.content}>
          {view.name === 'routines' ? (
            <RoutinesPage snapshot={snapshot} />
          ) : view.name === 'settings' ? (
            <SettingsPage settings={snapshot.settings} />
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
