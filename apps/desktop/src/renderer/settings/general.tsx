import { useState } from 'react'
import type { SettingsState } from '../../shared/bridge.ts'
import { savePreferences } from '../store.ts'
import { Switch } from '../ui/switch.tsx'
import { Row } from './row.tsx'
import styles from './settings-page.module.css'

/** General paths and desktop lifecycle preferences. */
export function General({ settings }: { settings: SettingsState }) {
  const [pending, setPending] = useState(false)
  return (
    <>
      <div className={styles.panelHead}>
        <div className={styles.heading}>
          <h2 className={styles.title2}>General</h2>
          <p className={styles.note}>
            Where Vela keeps its files and how the app quits.
          </p>
        </div>
      </div>
      <dl className={styles.rows}>
        <Row label="Vela folder" value={settings.folder} file="VELA_DIR" />
        <Row
          label="Config file"
          value={settings.files.config}
          file="config.json"
        />
      </dl>
      <div className={styles.heading}>
        <Switch
          label="Stop background service when quitting Vela"
          checked={settings.stopDaemonOnQuit}
          disabled={pending}
          onCheckedChange={(stopDaemonOnQuit) => {
            setPending(true)
            void savePreferences({ stopDaemonOnQuit }).finally(() =>
              setPending(false),
            )
          }}
        />
        <p className={styles.note}>
          Off by default so Lark groups and scheduled routines keep running when
          you close this window.
        </p>
      </div>
    </>
  )
}
