import type { Project } from '../../shared/bridge.ts'
import { projectName, projectTag } from '../format.ts'
import styles from './header-bar.module.css'

/**
 * 44px bar over the conversation: the page name, a project's source tag and folder
 * (or its chat id for a Lark group), and the one thing that needs the person when a
 * session waits for an answer.
 */
export function HeaderBar({
  project,
  title,
  waiting = false,
}: {
  project?: Project
  /** The page name when no project is open; Home otherwise. */
  title?: string
  waiting?: boolean
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
      {waiting ? (
        <p className={styles.waiting}>
          <span className={styles.dot} aria-hidden="true" />
          Waiting for you
        </p>
      ) : null}
    </header>
  )
}
