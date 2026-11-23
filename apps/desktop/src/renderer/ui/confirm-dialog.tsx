import { useRef } from 'react'
import { Button } from './button.tsx'
import styles from './confirm-dialog.module.css'
import { Dialog, DialogContent } from './dialog.tsx'

export function ConfirmDialog({
  title,
  description,
  trigger,
  onCancel,
  onConfirm,
}: {
  title: string
  description: string
  trigger: HTMLButtonElement
  onCancel: () => void
  onConfirm: () => void
}) {
  const cancel = useRef<HTMLButtonElement>(null)
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        title={title}
        description={description}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          cancel.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          trigger.focus()
        }}
      >
        <footer className={styles.actions}>
          <Button ref={cancel} variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {title}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
