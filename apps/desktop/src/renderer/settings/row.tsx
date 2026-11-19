import styles from './row.module.css'

/** One fact about the configuration, and the file it lives in. */
export function Row({
  label,
  value,
  file,
}: {
  label: string
  value: string
  file: string
}) {
  return (
    <div className={styles.row}>
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.value}>{value}</dd>
      <dd className={styles.file}>{file}</dd>
    </div>
  )
}
