import { PanelRight } from 'lucide-react'
import type { Project } from '../../shared/bridge.ts'
import styles from './header-bar.module.css'

/**
 * 44px bar over the conversation: the page name, a project's source tag and folder,
 * the waiting indicator, and a right-side panel toggle for visual balance.
 */
export function HeaderBar({
  project,
  title,
  waiting = false,
  panelOpen,
  onTogglePanel,
}: {
  project?: Project
  /** The page name when no project is open; Home otherwise. */
  title?: string
  waiting?: boolean
  panelOpen?: boolean
  onTogglePanel?: () => void
}) {
  return (
    <header className={styles.bar}>
      <h2 className={styles.title}>{project?.name ?? title ?? 'Home'}</h2>
      {project ? (
        <>
          <span className={styles.tag}>Local</span>
          <span className={styles.path} title={project.cwd}>
            {project.cwd}
          </span>
        </>
      ) : null}
      <div className={styles.right}>
        {waiting ? (
          <p className={styles.waiting}>
            <span className={styles.dot} aria-hidden="true" />
            Waiting for you
          </p>
        ) : null}
        {onTogglePanel ? (
          <button
            type="button"
            className={styles.toggle}
            aria-label={panelOpen ? 'Hide sessions' : 'Show sessions'}
            aria-pressed={panelOpen}
            onClick={onTogglePanel}
          >
            <PanelRight size={15} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </header>
  )
}
