import { useState } from 'react'
import type { SettingsState } from '../../shared/bridge.ts'
import { providerOf } from '../format.ts'
import { Button } from '../ui/button.tsx'
import { Dialog, DialogContent } from '../ui/dialog.tsx'
import { ModelForm } from './model-form.tsx'
import { Row } from './row.tsx'
import styles from './settings-page.module.css'

/** The model Vela answers with, each row naming the file it writes. */
export function Models({ settings }: { settings: SettingsState }) {
  const [editing, setEditing] = useState(false)
  const provider = settings.providers.find(
    (item) => item.name === providerOf(settings.model),
  )
  const keySource = provider?.credential
  return (
    <>
      <div className={styles.panelHead}>
        <div className={styles.heading}>
          <h2 className={styles.title2}>Models</h2>
          <p className={styles.note}>
            The model Vela answers with. A new key is checked with one small
            request before it is saved.
          </p>
        </div>
        <Button variant="secondary" onClick={() => setEditing(true)}>
          Change model
        </Button>
      </div>
      <dl className={styles.rows}>
        <Row
          label="Model"
          value={settings.model ?? 'Not set'}
          file="settings.json"
        />
        {settings.thinkingLevel ? (
          <Row
            label="Thinking level"
            value={settings.thinkingLevel}
            file="settings.json"
          />
        ) : null}
        <Row
          label="API key"
          value={keySource ? 'Saved' : 'Not saved'}
          // Where the credential actually comes from: a key Vela did not store is not in auth.json.
          file={keySource ?? 'auth.json'}
        />
        {provider?.custom ? (
          <Row
            label="Custom provider"
            value={`${provider.name} · ${provider.models.map((item) => item.id).join(', ')}`}
            file="models.json"
          />
        ) : null}
      </dl>
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent
          title="Change the model"
          description="Vela checks the key with one small request before saving it."
        >
          <ModelForm
            settings={settings}
            submitLabel="Verify and save"
            done={() => setEditing(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
