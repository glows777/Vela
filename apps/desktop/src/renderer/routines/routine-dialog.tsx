import { useEffect, useState } from 'react'
import type {
  Project,
  Routine,
  RoutineSchedule,
  Weekday,
} from '../../shared/bridge.ts'
import { projectName } from '../format.ts'
import { errorMessage } from '../store.ts'
import { Button } from '../ui/button.tsx'
import { Dialog, DialogClose, DialogContent } from '../ui/dialog.tsx'
import { Select } from '../ui/select.tsx'
import { vela } from '../vela.ts'
import styles from './routine-dialog.module.css'

const weekdays: { day: Weekday; label: string }[] = [
  { day: 'mon', label: 'Mon' },
  { day: 'tue', label: 'Tue' },
  { day: 'wed', label: 'Wed' },
  { day: 'thu', label: 'Thu' },
  { day: 'fri', label: 'Fri' },
  { day: 'sat', label: 'Sat' },
  { day: 'sun', label: 'Sun' },
]

/** A place a routine can answer in: a project's chat, or one of its topics. */
type Place = {
  key: string
  label: string
  project: Project
  target: { chatId: string; rootId?: string }
}

/** One dialog for New routine and Edit, because both ask the same questions. */
export function RoutineDialog({
  open,
  targets,
  editing,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  /** Projects a new routine can point at; Edit keeps the routine's own target. */
  targets: Project[]
  editing?: { project: Project; routine: Routine }
  onOpenChange: (open: boolean) => void
  onSaved: (projectId: string) => void
}) {
  const [message, setMessage] = useState('')
  const [mode, setMode] = useState<'once' | 'repeat'>('once')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('09:00')
  const [days, setDays] = useState<Weekday[]>([])
  const [places, setPlaces] = useState<Place[]>()
  const [where, setWhere] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    const routine = editing?.routine
    const schedule = routine?.schedule
    const once = schedule === undefined || 'at' in schedule
    setMessage(routine?.message ?? '')
    setMode(once ? 'once' : 'repeat')
    // A stored one-off `at` is the UTC instant the host resolved; `scheduleText` is the
    // wall clock it shows in its own timezone, which is what these fields hold.
    setDate(once ? (routine?.scheduleText.slice(0, 10) ?? '') : '')
    setTime(
      once
        ? (routine?.scheduleText.slice(11, 16) ?? '09:00')
        : schedule && !('at' in schedule)
          ? schedule.time
          : '09:00',
    )
    setDays(schedule && !('at' in schedule) ? (schedule.days ?? []) : [])
    setPlaces(undefined)
    setWhere('')
    setPending(false)
    setError('')
  }, [open, editing])

  // Where a new routine answers: each project's default target plus active sessions/topics.
  useEffect(() => {
    if (!open || editing) return
    let live = true
    void (async () => {
      try {
        const found = await Promise.all(
          targets.map(async (project) => {
            const name = projectName(project)
            const sessions = await vela.sessions(project.channel, project.id)
            const basePlace: Place = {
              key: `${project.id}:`,
              label:
                project.channel === 'lark'
                  ? `${name} · Group chat`
                  : `${name} · Project default`,
              project,
              target: { chatId: project.id },
            }
            const children = sessions.flatMap((session): Place[] => {
              if (session.isHub) return []
              if (project.channel === 'lark') {
                return session.topic
                  ? [
                      {
                        key: `${project.id}:${session.topic.rootId}`,
                        label: `${name} · topic “${session.task}”`,
                        project,
                        target: {
                          chatId: project.id,
                          rootId: session.topic.rootId,
                        },
                      },
                    ]
                  : []
              }
              return [
                {
                  key: `${project.id}:${session.sessionId}`,
                  label: `${name} · session “${session.task || 'New session'}”`,
                  project,
                  target: {
                    chatId: project.id,
                    rootId: session.sessionId,
                  },
                },
              ]
            })
            return [basePlace, ...children]
          }),
        )
        if (!live) return
        const all = found.flat()
        setPlaces(all)
        setWhere(all[0]?.key ?? '')
      } catch (cause) {
        if (live) setError(errorMessage(cause))
      }
    })()
    return () => {
      live = false
    }
  }, [open, editing, targets])

  const ready =
    message.trim() !== '' &&
    (mode === 'once' ? date !== '' && time !== '' : time !== '') &&
    (editing !== undefined || (where !== '' && (places?.length ?? 0) > 0))

  const save = async () => {
    if (!ready || pending) return
    const order = weekdays.map(({ day }) => day)
    const sorted = [...days].sort(
      (one, other) => order.indexOf(one) - order.indexOf(other),
    )
    const schedule: RoutineSchedule =
      mode === 'once'
        ? { at: `${date}T${time}` }
        : { time, ...(sorted.length ? { days: sorted } : {}) }
    setPending(true)
    setError('')
    try {
      if (editing) {
        const updated = await vela.editRoutine(
          editing.project.channel,
          editing.project.id,
          editing.routine.id,
          { message: message.trim(), schedule },
        )
        onSaved(editing.project.id)
        if (!updated) {
          // The host keeps no routine under that id, so say the change did not land.
          setError('This routine is no longer in this project.')
          return
        }
        onOpenChange(false)
        return
      }
      const place = places?.find((item) => item.key === where)
      if (!place) return
      await vela.createRoutine(place.project.channel, place.target, {
        message: message.trim(),
        schedule,
      })
      onOpenChange(false)
      onSaved(place.project.id)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  const toggleDay = (day: Weekday) =>
    setDays((current) =>
      current.includes(day)
        ? current.filter((item) => item !== day)
        : [...current, day],
    )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={editing ? 'Edit routine' : 'New routine'}
        description="Vela sends this message itself at the set time, then answers it like any other message."
      >
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div className={styles.field}>
            <label className={styles.label} htmlFor="routine-message">
              What Vela should do
            </label>
            <textarea
              id="routine-message"
              className={styles.input}
              rows={3}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Review the pull requests that still wait for me"
            />
          </div>
          <fieldset className={styles.when}>
            <legend className={styles.label}>When</legend>
            <div className={styles.modes}>
              {(['once', 'repeat'] as const).map((choice) => (
                <Button
                  key={choice}
                  type="button"
                  size="sm"
                  variant={mode === choice ? 'secondary' : 'ghost'}
                  aria-pressed={mode === choice}
                  onClick={() => setMode(choice)}
                >
                  {choice === 'once' ? 'Once' : 'Repeat'}
                </Button>
              ))}
            </div>
            {mode === 'once' ? (
              <div className={styles.row}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="routine-date">
                    Date
                  </label>
                  <input
                    id="routine-date"
                    className={styles.input}
                    type="date"
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="routine-time">
                    Time
                  </label>
                  <input
                    id="routine-time"
                    className={styles.input}
                    type="time"
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                  />
                </div>
              </div>
            ) : (
              <>
                <fieldset className={styles.days}>
                  <legend className={styles.label}>Days</legend>
                  {weekdays.map(({ day, label }) => (
                    <button
                      key={day}
                      type="button"
                      className={styles.day}
                      aria-pressed={days.includes(day)}
                      onClick={() => toggleDay(day)}
                    >
                      {label}
                    </button>
                  ))}
                </fieldset>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="routine-time">
                    Time
                  </label>
                  <input
                    id="routine-time"
                    className={styles.input}
                    type="time"
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                  />
                </div>
                <p className={styles.note}>No day selected means every day.</p>
              </>
            )}
          </fieldset>
          {editing ? (
            <div className={styles.field}>
              <span className={styles.label}>Where</span>
              <p className={styles.value}>{editing.routine.target}</p>
              <p className={styles.note}>
                A routine answers where it was set; this edits its message and
                time.
              </p>
            </div>
          ) : (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="routine-where">
                Where
              </label>
              {places === undefined ? (
                <p className={styles.note}>Reading where Vela can answer…</p>
              ) : places.length === 0 ? (
                <p className={styles.note}>
                  {targets.length === 0
                    ? 'Create or connect a project before adding a routine.'
                    : 'Routines answer in a project chat, so send a message in a project first.'}
                </p>
              ) : (
                <Select
                  id="routine-where"
                  label="Where"
                  value={where}
                  onChange={setWhere}
                  options={places.map(({ key, label }) => ({
                    value: key,
                    label,
                  }))}
                />
              )}
              <p className={styles.note}>
                Vela answers there, so anyone in that chat can read the answer.
              </p>
            </div>
          )}
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          <footer className={styles.actions}>
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" loading={pending} disabled={!ready}>
              {editing ? 'Save' : 'Create routine'}
            </Button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  )
}
