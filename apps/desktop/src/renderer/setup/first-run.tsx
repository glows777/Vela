import type { SettingsState } from '../../shared/bridge.ts'
import { Wordmark } from '../frame/wordmark.tsx'
import { ModelForm } from '../settings/model-form.tsx'
import styles from './first-run.module.css'

function reason(settings: SettingsState): string {
  if (settings.setup.reason === 'missing-credential')
    return `${settings.model} is the saved model, but ${settings.setup.provider} has no key. Add one below; Vela checks it before saving.`
  if (settings.setup.reason === 'unknown-model')
    return `${settings.model} is the saved model, but it can't be used any more: its provider is gone. Choose a provider and a model; the key is checked before it is saved.`
  return 'Vela has no model to answer with yet. Choose a provider and a model; the key is checked before it is saved.'
}

/**
 * The whole window until a model answers: the same form Settings › Models uses, so there is one
 * place where a key is entered and checked.
 */
export function FirstRun({ settings }: { settings: SettingsState }) {
  return (
    <div className={styles.page}>
      <div className={styles.column}>
        <Wordmark />
        <div className={styles.head}>
          <h1 className={styles.title}>Give Vela a model.</h1>
          <p className={styles.reason}>{reason(settings)}</p>
        </div>
        <ModelForm settings={settings} submitLabel="Verify and save" />
        <p className={styles.files}>
          The model goes in <code>settings.json</code> and the key in{' '}
          <code>auth.json</code>. Settings › General shows the folder.
        </p>
      </div>
    </div>
  )
}
