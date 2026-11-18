import type { Project } from '../../shared/bridge.ts'
import styles from './header-bar.module.css'

/** 44px bar over the conversation: the page name, and for a project its source tag and folder. */
export function HeaderBar({ project }: { project?: Project }) {
  return (
    <header className={styles.bar}>
      <h2 className={styles.title}>{project?.name ?? 'Home'}</h2>
      {project ? (
        <>
          <span className={styles.tag}>Local</span>
          <span className={styles.path}>{project.cwd}</span>
        </>
      ) : null}
    </header>
  )
}
