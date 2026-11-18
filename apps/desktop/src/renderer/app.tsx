import { useEffect, useState } from 'react'
import styles from './app.module.css'
import { needsYou } from './format.ts'
import { HeaderBar } from './frame/header-bar.tsx'
import { NewProjectDialog } from './frame/new-project.tsx'
import { Sidebar } from './frame/sidebar.tsx'
import { Home } from './home/home.tsx'
import { ProjectPage } from './project/project-page.tsx'
import { loadProject, start, useStore } from './store.ts'

type View = { name: 'home' } | { name: 'project'; projectId: string }
export type Panel = { open: boolean; sessionId?: string }

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

  const openProjectPage = (projectId: string) => {
    setView({ name: 'project', projectId })
    void loadProject(projectId)
  }

  const openSession = (projectId: string, sessionId: string) => {
    setPanel({ open: true, sessionId })
    openProjectPage(projectId)
  }

  const waiting = project
    ? needsYou(snapshot).some((session) => session.chatId === project.id)
    : false

  return (
    <div className={styles.app}>
      <Sidebar
        projects={snapshot.projects}
        current={view.name === 'home' ? 'home' : view.projectId}
        onHome={() => setView({ name: 'home' })}
        onProject={(projectId) => {
          setPanel({ open: panel.open })
          openProjectPage(projectId)
        }}
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
