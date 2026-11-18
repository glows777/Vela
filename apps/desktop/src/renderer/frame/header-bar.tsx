import type { Project } from '../../shared/bridge.ts'
import styles from './header-bar.module.css'

/**
 * 44px bar over the conversation: the page name, a project's source tag and folder,
 * and the one thing that needs the person when a session waits for an answer.
 */
export function HeaderBar({
  project,
  waiting = false,
}: {
  project?: Project
  waiting?: boolean
}) {
  return (
    <header className={styles.bar}>
      <h2 className={styles.title}>{project?.name ?? 'Home'}</h2>
      {project ? (
        <>
          <span className={styles.tag}>Local</span>
          <span className={styles.path}>{project.cwd}</span>
        </>
      ) : null}
      {waiting ? (
        <p className={styles.waiting}>
          <span className={styles.dot} aria-hidden="true" />
          Waiting for you
        </p>
      ) : null}
    </header>
  )
}
