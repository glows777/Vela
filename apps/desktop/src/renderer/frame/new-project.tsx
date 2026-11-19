import { useEffect, useState } from 'react'
import type { Project } from '../../shared/bridge.ts'
import { Button } from '../components/arc/button/button.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
} from '../components/arc/dialog/dialog.tsx'
import { Field, Input } from '../components/field.tsx'
import { errorMessage, openProject } from '../store.ts'
import { vela } from '../vela.ts'
import styles from './new-project.module.css'

/** Local only in this issue: pick a folder, name it, and open it as a project. */
export function NewProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (project: Project) => void
}) {
  const [folder, setFolder] = useState('')
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setFolder('')
    setName('')
    setError('')
  }, [open])

  const choose = async () => {
    try {
      const picked = await vela.chooseFolder()
      if (picked) setFolder(picked)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const create = async () => {
    if (!folder.trim() || pending) return
    setPending(true)
    try {
      const project = await openProject({
        cwd: folder.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
      })
      onOpenChange(false)
      onCreated(project)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New project"
        description="A project is where Vela works: a folder on this computer."
      >
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <Field label="Folder path" htmlFor="project-folder">
            <div className={styles.row}>
              <Input
                id="project-folder"
                className={styles.grow}
                value={folder}
                onChange={(event) => setFolder(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                type="button"
                variant="secondary"
                onClick={() => void choose()}
              >
                Choose folder
              </Button>
            </div>
          </Field>
          <Field
            label="Name"
            htmlFor="project-name"
            note="The name is optional; Vela uses the folder's name otherwise."
          >
            <Input
              id="project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="The folder's name"
              autoComplete="off"
            />
          </Field>
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
            <Button
              type="submit"
              loading={pending}
              disabled={folder.trim() === ''}
            >
              Create project
            </Button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  )
}
