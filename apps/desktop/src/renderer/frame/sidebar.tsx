import { Clock, House, Plus, SlidersHorizontal, SquarePen } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Project } from '../../shared/bridge.ts'
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

/** Fixed frame: macOS traffic-light top strip, quiet wordmark, lightweight nav, projects, and Settings. */
export function Sidebar({
  projects,
  current,
  onHome,
  onRoutines,
  onProject,
  onSettings,
  onNewSession,
  onNewProject,
}: {
  projects: Project[]
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
        <nav className={styles.nav} aria-label="Pages">
          <button
            type="button"
            className={styles.newSession}
            onClick={onNewSession}
          >
            <span className={styles.icon} aria-hidden="true">
              <SquarePen size={15} />
            </span>
            <span className={styles.rowLabel}>New session</span>
            <kbd className={styles.shortcut} aria-hidden="true">
              ⌘N
            </kbd>
          </button>
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
                    <span className={styles.dot} aria-hidden="true" />
                    <span className={styles.rowLabel}>{project.name}</span>
                    <span className={styles.tag}>Local</span>
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
