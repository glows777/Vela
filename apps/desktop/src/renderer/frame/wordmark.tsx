import styles from './wordmark.module.css'

/** VELA in display type over its offset copy: the sidebar heading and the label above a Vela turn. */
export function Wordmark({
  small = false,
  heading = false,
}: {
  small?: boolean
  heading?: boolean
}) {
  const className = [styles.base, small ? styles.small : ''].join(' ')
  return heading ? (
    <h1 className={className}>VELA</h1>
  ) : (
    <span className={className}>VELA</span>
  )
}
