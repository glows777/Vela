import type { ButtonHTMLAttributes } from 'react'
import { forwardRef } from 'react'
import styles from './button.module.css'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}

/** Native Vela button matching design/vela-app.html (.btn, .btn-primary, .btn-secondary). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      className,
      variant = 'primary',
      size = 'md',
      loading = false,
      disabled,
      type = 'button',
      children,
      onClick,
      ...props
    },
    ref,
  ) {
    const classes = [styles.button, styles[variant], styles[size], className]
      .filter(Boolean)
      .join(' ')

    return (
      <button
        ref={ref}
        type={type}
        className={classes}
        disabled={disabled}
        aria-busy={loading || undefined}
        aria-disabled={loading || props['aria-disabled'] || undefined}
        onClick={loading ? (event) => event.preventDefault() : onClick}
        {...props}
      >
        {loading ? (
          <span className={styles.loader} aria-hidden="true">
            <span className={styles.spinner} />
          </span>
        ) : null}
        <span className={loading ? styles.loadingLabel : styles.label}>
          {children}
        </span>
      </button>
    )
  },
)
