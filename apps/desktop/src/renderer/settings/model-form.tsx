import { useState } from 'react'
import type {
  ModelSetup,
  ProviderApi,
  SettingsState,
} from '../../shared/bridge.ts'
import { Button } from '../components/arc/button/button.tsx'
import { Field, Input, Select } from '../components/field.tsx'
import { fileName, providerOf } from '../format.ts'
import { errorMessage, saveModel } from '../store.ts'
import styles from './model-form.module.css'

/** The select value for a provider models.json doesn't define yet. */
const CUSTOM = ''
const APIS: { value: ProviderApi; label: string }[] = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
]

/**
 * Provider, key, then model. `saveModel` checks the key with one small request before anything is
 * written, so a wrong key never reaches auth.json.
 */
export function ModelForm({
  settings,
  submitLabel,
  done,
}: {
  settings: SettingsState
  submitLabel: string
  done?: () => void
}) {
  const savedProvider = providerOf(settings.model)
  const [provider, setProvider] = useState(() =>
    settings.providers.some((item) => item.name === savedProvider)
      ? savedProvider
      : (settings.providers.find((item) => item.credential)?.name ??
        settings.providers[0]?.name ??
        CUSTOM),
  )
  const [name, setName] = useState('')
  const [api, setApi] = useState<ProviderApi>('openai-completions')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState(() => {
    if (savedProvider && settings.model)
      return settings.model.slice(savedProvider.length + 1)
    return (
      settings.providers.find((item) => item.name === savedProvider)?.models[0]
        ?.id ?? ''
    )
  })
  const [key, setKey] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  const custom = provider === CUSTOM
  const chosen = settings.providers.find((item) => item.name === provider)
  const providerName = custom ? name.trim() : provider
  const needsKey = custom || !chosen?.credential
  const canSubmit =
    providerName !== '' &&
    model.trim() !== '' &&
    (!custom || baseUrl.trim() !== '') &&
    (!needsKey || key.trim() !== '')

  const pickProvider = (value: string) => {
    setProvider(value)
    setError('')
    const next = settings.providers.find((item) => item.name === value)
    setModel(
      value === savedProvider && settings.model
        ? settings.model.slice(value.length + 1)
        : (next?.models[0]?.id ?? ''),
    )
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSubmit || pending) return
    setPending(true)
    setError('')
    const input: ModelSetup = {
      provider: providerName,
      model: model.trim(),
      ...(key.trim() ? { key: key.trim() } : {}),
      ...(custom ? { custom: { api, baseUrl: baseUrl.trim() } } : {}),
    }
    try {
      await saveModel(input)
      setKey('')
      done?.()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <Field label="Provider" htmlFor="model-provider">
        <Select
          id="model-provider"
          value={provider}
          onChange={(event) => pickProvider(event.target.value)}
        >
          {settings.providers.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
              {item.credential ? '' : ' (no key)'}
            </option>
          ))}
          <option value={CUSTOM}>Custom provider</option>
        </Select>
      </Field>
      {custom ? (
        <>
          <Field
            label="Provider name"
            htmlFor="model-provider-name"
            note="The name in models.json and auth.json."
          >
            <Input
              id="model-provider-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Protocol" htmlFor="model-api">
            <Select
              id="model-api"
              value={api}
              onChange={(event) => setApi(event.target.value as ProviderApi)}
            >
              {APIS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Base URL"
            htmlFor="model-base-url"
            note="The endpoint without /chat/completions or /responses."
          >
            <Input
              id="model-base-url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://example.com/v1"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        </>
      ) : null}
      <Field
        label={custom ? 'API key' : `API key for ${provider}`}
        htmlFor="model-key"
        note={
          custom || !chosen?.credential
            ? `Saved in ${fileName(settings.files.auth)}.`
            : `Saved in ${chosen.credential}; leave empty to keep it.`
        }
      >
        <Input
          id="model-key"
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      {custom || !chosen || chosen.models.length === 0 ? (
        <Field
          label="Model ID"
          htmlFor="model-id"
          note="Exactly as the provider names it."
        >
          <Input
            id="model-id"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      ) : (
        <Field label="Model" htmlFor="model-id">
          <Select
            id="model-id"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            {chosen.models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <footer className={styles.actions}>
        <Button type="submit" loading={pending} disabled={!canSubmit}>
          {submitLabel}
        </Button>
      </footer>
    </form>
  )
}
