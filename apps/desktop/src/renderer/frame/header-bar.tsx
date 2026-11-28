import { PanelRight, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { Project } from '../../shared/bridge.ts'
import { projectName, projectTag } from '../format.ts'
import { ConfirmDialog } from '../ui/confirm-dialog.tsx'
import styles from './header-bar.module.css'

/**
 * 44px conversation bar: page name, source and folder or Lark chat ID, a waiting
 * indicator, Remove project (on Local projects), and the right-side sessions toggle.
 */
export function HeaderBar({
  project,
  title,
  waiting = false,
  panelOpen,
  onTogglePanel,
  onRemoveProject,
}: {
  project?: Project
  /** The page name when no project is open; Home otherwise. */
  title?: string
  waiting?: boolean
  panelOpen?: boolean
  onTogglePanel?: () => void
  onRemoveProject?: () => void
}) {
  const [confirmRemove, setConfirmRemove] = useState<HTMLButtonElement>()
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
        {project?.channel === 'local' && onRemoveProject ? (
          <button
            type="button"
            className={styles.toggle}
            aria-label="Remove project"
            title="Remove project"
            onClick={(event) => setConfirmRemove(event.currentTarget)}
          >
            <Trash2 size={15} aria-hidden="true" />
          </button>
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
      {confirmRemove && project?.channel === 'local' && onRemoveProject ? (
        <ConfirmDialog
          title="Remove project"
          description={`Remove “${projectName(project)}” from Vela? Files in ${project.cwd} stay on this computer.`}
          trigger={confirmRemove}
          onCancel={() => setConfirmRemove(undefined)}
          onConfirm={() => {
            setConfirmRemove(undefined)
            onRemoveProject()
          }}
        />
      ) : null}
    </header>
  )
}
