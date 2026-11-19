import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import styles from './field.module.css'

/** A label, one control, and at most one line of help: the app's only field shape. */
export function Field({
  label,
  htmlFor,
  note,
  error,
  children,
}: {
  label: string
  htmlFor: string
  note?: string
  error?: string
  children: ReactNode
}) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {note ? <p className={styles.note}>{note}</p> : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function Input({
  className,
  ...props
}: ComponentPropsWithoutRef<'input'>) {
  return (
    <input
      className={className ? `${styles.input} ${className}` : styles.input}
      {...props}
    />
  )
}

export function Select({
  className,
  ...props
}: ComponentPropsWithoutRef<'select'>) {
  return (
    <select
      className={className ? `${styles.input} ${className}` : styles.input}
      {...props}
    />
  )
}
