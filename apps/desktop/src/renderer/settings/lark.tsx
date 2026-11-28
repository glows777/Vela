import { useEffect, useState } from 'react'
import type { LarkSetup, SettingsState } from '../../shared/bridge.ts'
import { Field, Input } from '../components/field.tsx'
import { errorMessage, saveLark } from '../store.ts'
import { Button } from '../ui/button.tsx'
import { ConfirmDialog } from '../ui/confirm-dialog.tsx'
import { Switch } from '../ui/switch.tsx'
import { vela } from '../vela.ts'
import form from './model-form.module.css'
import styles from './settings-page.module.css'

export function Lark({ settings }: { settings: SettingsState['lark'] }) {
  const [id, setId] = useState(settings.appId)
  const [secret, setSecret] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [removing, setRemoving] = useState<{
    chat: string
    trigger: HTMLButtonElement
  }>()
  useEffect(() => {
    if (!settings.loaded) return
    let current = true
    let observed = false
    const show = (value: Awaited<ReturnType<typeof vela.connection>>) =>
      setStatus(value.connected ? 'Connected' : (value.error ?? 'Disconnected'))
    const off = vela.onEvent((event) => {
      if (event.type === 'connection' && event.channel === 'lark') {
        observed = true
        show(event.value)
      }
    })
    void vela.connection('lark').then(
      (value) => {
        if (current && !observed) show(value)
      },
      (cause) => {
        if (current && !observed) setStatus(errorMessage(cause))
      },
    )
    return () => {
      current = false
      off()
    }
  }, [settings])

  async function save(input: LarkSetup) {
    setError('')
    setPending(true)
    try {
      await saveLark(input)
      if ('appId' in input) setSecret('')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      <div className={styles.heading}>
        <h2 className={styles.title2}>Lark</h2>
        {settings.startupError ? (
          <p className={form.error} role="alert">
            {settings.startupError} Local is available.
          </p>
        ) : (
          <p role="status">
            {settings.loaded
              ? status
              : settings.enabled
                ? 'Lark is not loaded in this app'
                : 'Off on this computer'}
          </p>
        )}
      </div>
      <div className={styles.heading}>
        <Switch
          label="Enable Lark connection on this computer"
          checked={settings.enabled}
          disabled={pending}
          onCheckedChange={(enabled) => void save({ enabled })}
        />
        <p className={styles.note}>
          Saved locally on this computer. Local chats keep running even when
          Lark is turned off.
        </p>
      </div>
      <form
        className={form.form}
        onSubmit={(event) => {
          event.preventDefault()
          void save({ appId: id, ...(secret ? { appSecret: secret } : {}) })
        }}
      >
        <Field htmlFor="lark-app-id" label="App ID" note="config.json">
          <Input
            id="lark-app-id"
            required
            value={id}
            disabled={pending}
            onChange={(event) => setId(event.target.value)}
          />
        </Field>
        <Field
          htmlFor="lark-secret"
          label="App secret"
          note={
            settings.appSecretSaved
              ? 'Leave blank to keep the current secret. Changes are saved in config.json.'
              : 'Saved to config.json after verification.'
          }
        >
          <Input
            id="lark-secret"
            type="password"
            autoComplete="new-password"
            required={!settings.appSecretSaved}
            value={secret}
            disabled={pending}
            onChange={(event) => setSecret(event.target.value)}
          />
        </Field>
        <div className={form.actions}>
          <Button type="submit" variant="secondary" disabled={pending}>
            Save credentials
          </Button>
        </div>
      </form>
      {error && (
        <p className={form.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.heading}>
        <h3 className={styles.title2}>Enabled chats</h3>
        <p className={styles.note}>
          {settings.envExpression
            ? 'These chats use an environment expression. Edit it in config.json.'
            : 'Removing a chat updates config.json.'}
        </p>
      </div>
      {settings.chats.length ? (
        <ul className={styles.chats}>
          {settings.chats.map((chat) => (
            <li key={chat}>
              <code>{chat}</code>
              <Button
                variant="secondary"
                aria-label={`Remove ${chat}`}
                disabled={pending || settings.envExpression}
                onClick={(event) =>
                  setRemoving({ chat, trigger: event.currentTarget })
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.note}>No enabled chats.</p>
      )}
      {removing ? (
        <ConfirmDialog
          title="Remove chat"
          description={`Vela will stop answering in ${removing.chat}.`}
          trigger={removing.trigger}
          onCancel={() => setRemoving(undefined)}
          onConfirm={() => {
            setRemoving(undefined)
            void save({ removeChat: removing.chat })
          }}
        />
      ) : null}
    </>
  )
}
