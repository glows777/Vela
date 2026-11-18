import { useEffect, useState } from 'react'
import styles from './app.module.css'
import { needsYou } from './format.ts'
import { HeaderBar } from './frame/header-bar.tsx'
import { NewProjectDialog } from './frame/new-project.tsx'
import { Sidebar } from './frame/sidebar.tsx'
import { Home } from './home/home.tsx'
import type { Panel } from './panel.ts'
import { ProjectPage } from './project/project-page.tsx'
import { loadProject, start, useStore } from './store.ts'

type View = { name: 'home' } | { name: 'project'; projectId: string }

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
   * project all land on the same state.
   */
  const openProjectPage = (projectId: string, sessionId?: string) => {
    setView({ name: 'project', projectId })
    setPanel({ open: panel.open, ...(sessionId ? { sessionId } : {}) })
    void loadProject(projectId)
  }

  const openSession = (projectId: string, sessionId: string) =>
    openProjectPage(projectId, sessionId)

  const waiting = project
    ? needsYou(snapshot).some((session) => session.chatId === project.id)
    : false

  return (
    <div className={styles.app}>
      <Sidebar
        projects={snapshot.projects}
        current={view.name === 'home' ? 'home' : view.projectId}
        onHome={() => setView({ name: 'home' })}
        onProject={openProjectPage}
        onNewSession={() => {
          setView({ name: 'home' })
          setFocusSignal((value) => value + 1)
        }}
        onNewProject={() => setCreating(true)}
      />
      <div className={styles.main}>
        <HeaderBar project={project} waiting={waiting} />
        <main className={styles.content}>
          {project ? (
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
