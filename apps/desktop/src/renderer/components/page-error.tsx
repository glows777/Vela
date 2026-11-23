import { X } from 'lucide-react'
import { dismissPageError } from '../store.ts'
import styles from './page-error.module.css'

export function PageError({
  message,
  className,
  onDismiss = dismissPageError,
}: {
  message: string
  className?: string
  onDismiss?: () => void
}) {
  return (
    <div className={[className, styles.banner].filter(Boolean).join(' ')}>
      <span role="alert">{message}</span>
      <button
        type="button"
        className={styles.dismiss}
        aria-label="Dismiss error"
        onClick={onDismiss}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
