import { Clock, Folder, House, Plus, SlidersHorizontal } from 'lucide-react'
import type { ReactNode } from 'react'
import icon from '../../assets/vela-icon-180.png'
import type { Project } from '../../shared/bridge.ts'
import { Button } from '../components/arc/button/button.tsx'
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
      {icon}
      <span className={styles.rowLabel}>{label}</span>
    </button>
  )
}

/** Fixed frame: the wordmark, the two ways to create, projects, and the pages under them. */
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
      <div className={styles.brand}>
        <img className={styles.mark} src={icon} width={36} height={36} alt="" />
        <Wordmark heading />
      </div>
      <Button size="lg" onClick={onNewSession}>
        New session
      </Button>
      <nav className={styles.nav} aria-label="Pages">
        <Row
          icon={<House size={16} aria-hidden="true" />}
          label="Home"
          current={current === 'home'}
          onClick={onHome}
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
            <Plus size={16} aria-hidden="true" />
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
                  <Folder size={16} aria-hidden="true" />
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
          icon={<Clock size={16} aria-hidden="true" />}
          label="Routines"
          current={current === 'routines'}
          onClick={onRoutines}
        />
        <Row
          icon={<SlidersHorizontal size={16} aria-hidden="true" />}
          label="Settings"
          current={current === 'settings'}
          onClick={onSettings}
        />
      </div>
    </aside>
  )
}
