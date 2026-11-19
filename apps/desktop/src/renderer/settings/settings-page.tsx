import { useState } from 'react'
import type { SettingsState } from '../../shared/bridge.ts'
import { General } from './general.tsx'
import { Models } from './models.tsx'
import styles from './settings-page.module.css'

type Section = 'general' | 'models'
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'models', label: 'Models' },
]

/** Settings: one left nav, and only the pages this issue needs. */
export function SettingsPage({ settings }: { settings: SettingsState }) {
  const [section, setSection] = useState<Section>('general')
  return (
    <div className={styles.page}>
      <div className={styles.column}>
        <h1 className={styles.title}>Settings</h1>
        <div className={styles.body}>
          <nav className={styles.nav} aria-label="Settings sections">
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={styles.navRow}
                aria-current={section === item.id ? 'page' : undefined}
                onClick={() => setSection(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <section className={styles.panel}>
            {section === 'models' ? (
              <Models settings={settings} />
            ) : (
              <General settings={settings} />
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
