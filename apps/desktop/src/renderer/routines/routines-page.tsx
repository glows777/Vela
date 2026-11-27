import { Clock, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Project, Routine } from '../../shared/bridge.ts'
import { projectName, projectTag } from '../format.ts'
import { errorMessage, type Snapshot } from '../store.ts'
import { Button } from '../ui/button.tsx'
import { ConfirmDialog } from '../ui/confirm-dialog.tsx'
import { vela } from '../vela.ts'
import { RoutineDialog } from './routine-dialog.tsx'
import styles from './routines-page.module.css'

/** One project's routines, or why the page cannot show them. */
type Group = {
  project: Project
  timezone?: string
  routines?: Routine[]
  error?: string
  actionError?: string
}

async function loadGroup(project: Project): Promise<Group> {
  try {
    const { timezone, routines } = await vela.listRoutines(
      project.channel,
      project.id,
    )
    return { project, timezone, routines }
  } catch (cause) {
    return { project, error: errorMessage(cause) }
  }
}

/** Every routine Vela will send, grouped by the project it answers in. */
export function RoutinesPage({ snapshot }: { snapshot: Snapshot }) {
  const projects = useMemo(() => snapshot.projects, [snapshot.projects])
  const [groups, setGroups] = useState<Group[]>([])
  const [loaded, setLoaded] = useState(false)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<{
    project: Project
    routine: Routine
  }>()

  const [deleting, setDeleting] = useState<{
    group: Group
    routine: Routine
    trigger: HTMLButtonElement
  }>()

  useEffect(() => {
    let live = true
    void Promise.all(projects.map(loadGroup)).then((next) => {
      if (!live) return
      setGroups(next)
      setLoaded(true)
    })
    return () => {
      live = false
    }
  }, [projects])

  const refresh = async (projectIds: string[]) => {
    const next = await Promise.all(
      projects
        .filter((project) => projectIds.includes(project.id))
        .map(loadGroup),
    )
    setGroups((current) =>
      current.map(
        (group) =>
          next.find((item) => item.project.id === group.project.id) ?? group,
      ),
    )
  }

  const remove = async (group: Group, routine: Routine) => {
    const clear = () =>
      setGroups((current) =>
        current.map((item) =>
          item.project.id === group.project.id
            ? { ...item, actionError: undefined }
            : item,
        ),
      )
    clear()
    try {
      await vela.cancelRoutine(
        group.project.channel,
        group.project.id,
        routine.id,
      )
    } catch (cause) {
      const actionError = errorMessage(cause)
      setGroups((current) =>
        current.map((item) =>
          item.project.id === group.project.id
            ? { ...item, actionError }
            : item,
        ),
      )
      return
    }
    await refresh([group.project.id])
  }

  const targets = useMemo(
    () => groups.filter((group) => !group.error).map((group) => group.project),
    [groups],
  )

  if (!loaded || !snapshot.ready) {
    return <div className={styles.page} aria-busy="true" />
  }

  return (
    <div className={styles.page}>
      <div className={styles.column}>
        <div className={styles.bar}>
          <p className={styles.lead}>
            A routine is a message Vela sends itself at a set time. It answers
            it like any other message.
          </p>
          <Button type="button" onClick={() => setCreating(true)}>
            New routine
          </Button>
        </div>
        {groups.length === 0 ? (
          <p className={styles.note}>
            Create a project to give Vela a routine.
          </p>
        ) : null}
        {groups.map((group) => (
          <section
            key={group.project.id}
            className={styles.group}
            aria-label={projectName(group.project)}
          >
            <h2 className={styles.groupHead}>
              <span>{projectName(group.project)}</span>
              <span className={styles.tag}>{projectTag(group.project)}</span>
              {group.timezone ? (
                <span className={styles.zone}>times in {group.timezone}</span>
              ) : null}
            </h2>
            {group.actionError ? (
              <p className={styles.error} role="alert">
                {group.actionError}
              </p>
            ) : null}
            {group.error ? (
              <p className={styles.error} role="alert">
                {group.error}
              </p>
            ) : group.routines?.length ? (
              <ul className={styles.list}>
                {group.routines.map((routine) => (
                  <li key={routine.id} className={styles.row}>
                    <Clock
                      className={styles.clock}
                      size={16}
                      aria-hidden="true"
                    />
                    <div className={styles.what}>
                      <p className={styles.message}>{routine.message}</p>
                      <p className={styles.meta}>
                        {routine.target} · set by {routine.creator.name}
                      </p>
                    </div>
                    <div className={styles.when}>
                      <p className={styles.schedule}>{routine.scheduleText}</p>
                      <p className={styles.meta}>
                        Next: {routine.nextRun ?? 'no future occurrence'}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      aria-label={`Edit routine: ${routine.message}`}
                      onClick={() =>
                        setEditing({ project: group.project, routine })
                      }
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete routine: ${routine.message}`}
                      onClick={(event) =>
                        setDeleting({
                          group,
                          routine,
                          trigger: event.currentTarget,
                        })
                      }
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.note}>No routines yet.</p>
            )}
          </section>
        ))}
      </div>
      {deleting ? (
        <ConfirmDialog
          title="Delete routine"
          description={`“${deleting.routine.message}” will no longer run.`}
          trigger={deleting.trigger}
          onCancel={() => setDeleting(undefined)}
          onConfirm={() => {
            setDeleting(undefined)
            void remove(deleting.group, deleting.routine)
          }}
        />
      ) : null}
      <RoutineDialog
        open={creating || editing !== undefined}
        targets={targets}
        editing={editing}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false)
            setEditing(undefined)
          }
        }}
        onSaved={(projectId) => void refresh([projectId])}
      />
    </div>
  )
}
