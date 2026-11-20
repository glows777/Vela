import { useEffect, useRef, useState } from 'react'
import type { Project } from '../../shared/bridge.ts'
import { Field, Input } from '../components/field.tsx'
import {
  confirmLarkGroup,
  errorMessage,
  openProject,
  useStore,
} from '../store.ts'
import { Button } from '../ui/button.tsx'
import { Dialog, DialogClose, DialogContent } from '../ui/dialog.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs.tsx'
import { vela } from '../vela.ts'
import styles from './new-project.module.css'

export function NewProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (project: Project) => void
}) {
  const { projects } = useStore()
  const [source, setSource] = useState('local')
  const [step, setStep] = useState<
    'list' | 'mention' | 'confirm' | 'saving' | 'cancelling'
  >('list')
  const [chatId, setChatId] = useState('')
  const active = useRef(false)
  const [folder, setFolder] = useState('')
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setSource('local')
    setStep('list')
    setFolder('')
    setName('')
    setError('')
  }, [open])

  useEffect(
    () => () => {
      if (active.current) void vela.cancelLarkSetup().catch(() => {})
    },
    [],
  )

  const discover = async () => {
    if (active.current) return
    active.current = true
    setStep('mention')
    setError('')
    try {
      const found = await vela.discoverLarkGroup()
      if (found && active.current) {
        setChatId(found.chatId)
        setStep('confirm')
      }
    } catch (cause) {
      if (active.current) {
        setError(errorMessage(cause))
        setStep('list')
        active.current = false
      }
    }
  }

  const cancel = async (close: boolean) => {
    if (step === 'saving' || step === 'cancelling') return
    if (active.current) {
      active.current = false
      setStep('cancelling')
      try {
        await vela.cancelLarkSetup()
      } catch (cause) {
        setError(errorMessage(cause))
        setStep('list')
        return
      }
    }
    setStep('list')
    if (close) onOpenChange(false)
  }

  const enable = async () => {
    setStep('saving')
    try {
      const project = await confirmLarkGroup(chatId)
      onOpenChange(false)
      onCreated(project)
    } catch (cause) {
      setError(errorMessage(cause))
      setStep('list')
    } finally {
      active.current = false
    }
  }

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
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : void cancel(true))}
    >
      <DialogContent
        title="New project"
        description={
          source === 'local'
            ? 'Choose a folder on this computer.'
            : 'Choose a Lark group.'
        }
      >
        <Tabs
          value={source}
          onValueChange={(value) => {
            setSource(value)
            setError('')
          }}
        >
          <TabsList aria-label="Project source">
            <TabsTrigger value="local" disabled={step !== 'list'}>
              Local
            </TabsTrigger>
            <TabsTrigger value="lark" disabled={pending}>
              Lark
            </TabsTrigger>
          </TabsList>
          <TabsContent value="local">
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
          </TabsContent>
          <TabsContent value="lark">
            <div className={styles.form}>
              {step === 'list' ? (
                <>
                  {projects
                    .filter((project) => project.channel === 'lark')
                    .map((project) => (
                      <Button
                        key={project.id}
                        variant="secondary"
                        onClick={() => {
                          onOpenChange(false)
                          onCreated(project)
                        }}
                      >
                        {project.name ?? <code>{project.id}</code>}
                      </Button>
                    ))}
                  <Button onClick={() => void discover()}>Add a group</Button>
                </>
              ) : (
                <>
                  {step === 'mention' ? (
                    <p role="status">
                      Mention the bot in the new Lark group. Until a new group
                      is found or you cancel, Local and Lark are paused. Vela
                      won’t answer messages sent to enabled groups during this
                      time.
                    </p>
                  ) : null}
                  {step === 'confirm' || step === 'saving' ? (
                    <Field
                      label="Lark group ID"
                      htmlFor="lark-candidate-id"
                      note="Enable this group only if the ID matches the group you intended. Every member will have full access to Vela’s tools, including running commands on this computer."
                    >
                      <output id="lark-candidate-id">{chatId}</output>
                    </Field>
                  ) : null}
                  <footer className={styles.actions}>
                    <Button
                      variant="ghost"
                      disabled={step === 'saving' || step === 'cancelling'}
                      onClick={() => void cancel(false)}
                    >
                      Cancel
                    </Button>
                    {step === 'confirm' || step === 'saving' ? (
                      <Button
                        loading={step === 'saving'}
                        onClick={() => void enable()}
                      >
                        Enable group
                      </Button>
                    ) : null}
                  </footer>
                </>
              )}
              {error ? (
                <p className={styles.error} role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
