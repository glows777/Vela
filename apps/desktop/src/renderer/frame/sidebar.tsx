import {
  Clock,
  Folder,
  House,
  MessageSquare,
  Plus,
  SlidersHorizontal,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { Connection, Project } from '../../shared/bridge.ts'
import { projectName, projectNameIsId, projectTag } from '../format.ts'
import styles from './sidebar.module.css'
import { Wordmark } from './wordmark.tsx'

function Row({
  icon,
  label,
  current = false,
  disabled = false,
  onClick,
}: {
  icon: ReactNode
  label: string
  current?: boolean
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      className={styles.row}
      aria-current={current ? 'page' : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <span className={styles.icon} aria-hidden="true">
        {icon}
      </span>
      <span className={styles.rowLabel}>{label}</span>
    </button>
  )
}

/** The Lark connection line under the wordmark: on, or off with the host's reason. */
function LarkState({ connection }: { connection: Connection }) {
  return (
    <div className={styles.connection}>
      <p
        className={styles.connectionLine}
        title={connection.error}
        data-connected={connection.connected}
      >
        <span className={styles.connectionDot} aria-hidden="true" />
        Lark · {connection.connected ? 'on' : 'off'}
      </p>
      {!connection.connected && connection.error ? (
        <p className={styles.connectionError}>{connection.error}</p>
      ) : null}
    </div>
  )
}

/** Fixed frame: macOS traffic-light top strip, wordmark, primary action, projects, and Settings. */
export function Sidebar({
  projects,
  connections,
  current,
  onHome,
  onRoutines,
  onProject,
  onSettings,
  onNewSession,
  onNewProject,
}: {
  projects: Project[]
  connections: Record<string, Connection>
  current: string
  onHome: () => void
  onRoutines: () => void
  onProject: (projectId: string) => void
  onSettings: () => void
  onNewSession: () => void
  onNewProject: () => void
}) {
  return (
    <aside className={styles.sidebar} aria-label="Sidebar">
      <div className={styles.windowDrag}>
        <span className={styles.mode}>Local</span>
      </div>
      <div className={styles.inner}>
        <div className={styles.brand}>
          <Wordmark heading />
        </div>
        {connections.lark ? <LarkState connection={connections.lark} /> : null}
        <button
          type="button"
          className={styles.newSession}
          aria-label="New session"
          onClick={onNewSession}
        >
          <span className={styles.newSessionMain}>
            <Plus size={15} aria-hidden="true" />
            New session
          </span>
          <kbd className={styles.shortcut}>⌘N</kbd>
        </button>
        <nav className={styles.nav} aria-label="Pages">
          <Row
            icon={<House size={15} />}
            label="Home"
            current={current === 'home'}
            onClick={onHome}
          />
          <Row
            icon={<Clock size={15} />}
            label="Routines"
            current={current === 'routines'}
            onClick={onRoutines}
          />
        </nav>
        <section className={styles.projects} aria-label="Projects">
          <div className={styles.sectionHead}>
            <h2 className={styles.label}>Projects</h2>
            <button
              type="button"
              className={styles.add}
              aria-label="New project"
              onClick={onNewProject}
            >
              <Plus size={14} aria-hidden="true" />
            </button>
          </div>
          {projects.length === 0 ? (
            <p className={styles.empty}>No projects yet.</p>
          ) : (
            <ul className={styles.list}>
              {projects.map((project) => (
                <li key={project.id}>
                  <button
                    type="button"
                    className={styles.row}
                    aria-current={current === project.id ? 'page' : undefined}
                    onClick={() => onProject(project.id)}
                  >
                    {project.channel === 'lark' ? (
                      <MessageSquare size={15} aria-hidden="true" />
                    ) : (
                      <Folder size={15} aria-hidden="true" />
                    )}
                    <span
                      className={[
                        styles.rowLabel,
                        projectNameIsId(project) ? styles.mono : '',
                      ].join(' ')}
                    >
                      {projectName(project)}
                    </span>
                    <span className={styles.tag}>{projectTag(project)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <div className={styles.footer}>
          <Row
            icon={<SlidersHorizontal size={15} />}
            label="Settings"
            current={current === 'settings'}
            onClick={onSettings}
          />
        </div>
      </div>
    </aside>
  )
}
