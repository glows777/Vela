import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { createContext, useCallback, useContext, useState } from 'react'
import styles from './dialog.module.css'
import { velaMotion } from './motion.ts'

const OpenContext = createContext<boolean | null>(null)

export function Dialog({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Root>) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen)
  const open = openProp ?? uncontrolled
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setUncontrolled(next)
      onOpenChange?.(next)
    },
    [openProp, onOpenChange],
  )
  return (
    <OpenContext.Provider value={open}>
      <DialogPrimitive.Root {...props} open={open} onOpenChange={setOpen} />
    </OpenContext.Provider>
  )
}

export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

export interface DialogContentProps
  extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  title: string
  description?: string
  children: ReactNode
}

/** Native Vela dialog on Radix primitives: scrim fades, surface scales from 0.98 at quick ease-out. */
export function DialogContent({
  title,
  description,
  children,
  className,
  ...props
}: DialogContentProps) {
  const open = useContext(OpenContext)
  const reduced = useReducedMotion() ?? false
  const classes = [styles.content, className].filter(Boolean).join(' ')
  const inner = (
    <>
      <header className={styles.header}>
        <div className={styles.titles}>
          <DialogPrimitive.Title className={styles.title}>
            {title}
          </DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className={styles.description}>
              {description}
            </DialogPrimitive.Description>
          ) : null}
        </div>
        <DialogPrimitive.Close
          className={styles.close}
          aria-label="Close dialog"
        >
          <X size={16} aria-hidden="true" />
        </DialogPrimitive.Close>
      </header>
      <div className={styles.body}>{children}</div>
    </>
  )

  if (open === null) {
    return (
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={styles.overlay} />
        <DialogPrimitive.Content {...props} className={classes}>
          {inner}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    )
  }

  const transition = {
    duration: velaMotion.duration.quick,
    ease: [...velaMotion.ease.out],
  }

  return (
    <AnimatePresence>
      {open ? (
        <DialogPrimitive.Portal key="dialog" forceMount>
          <DialogPrimitive.Overlay asChild forceMount>
            <motion.div
              className={styles.overlay}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={transition}
            />
          </DialogPrimitive.Overlay>
          <DialogPrimitive.Content {...props} asChild forceMount>
            <motion.div
              className={classes}
              initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={transition}
            >
              {inner}
            </motion.div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      ) : null}
    </AnimatePresence>
  )
}
