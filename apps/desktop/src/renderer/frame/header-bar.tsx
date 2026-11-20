import { PanelRight } from 'lucide-react'
import type { Project } from '../../shared/bridge.ts'
import { projectName, projectTag } from '../format.ts'
import styles from './header-bar.module.css'

/**
 * 44px conversation bar: page name, source and folder or Lark chat ID, a waiting
 * indicator, and the right-side sessions toggle.
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
  // A group with no readable name already shows its chat id as the title.
  const detail =
    project?.channel === 'lark'
      ? project.name
        ? project.id
        : undefined
      : project?.cwd
  return (
    <header className={styles.bar}>
      <h2 className={styles.title}>
        {project ? projectName(project) : (title ?? 'Home')}
      </h2>
      {project ? (
        <>
          <span className={styles.tag}>{projectTag(project)}</span>
          {detail ? (
            <span className={styles.path} title={detail}>
              {detail}
            </span>
          ) : null}
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
