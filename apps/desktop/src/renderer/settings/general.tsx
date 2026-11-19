import type { SettingsState } from '../../shared/bridge.ts'
import { Row } from './row.tsx'
import styles from './settings-page.module.css'

/** What the other pages need to say where it lives. */
export function General({ settings }: { settings: SettingsState }) {
  return (
    <>
      <div className={styles.panelHead}>
        <div className={styles.heading}>
          <h2 className={styles.title2}>General</h2>
          <p className={styles.note}>Where Vela keeps its files.</p>
        </div>
      </div>
      <dl className={styles.rows}>
        <Row label="Vela folder" value={settings.folder} file="VELA_DIR" />
        <Row
          label="Settings file"
          value={settings.files.settings}
          file="settings.json"
        />
      </dl>
    </>
  )
}
