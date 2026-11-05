import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SelectItem } from '@earendil-works/pi-tui'
import {
  type AuthInteraction,
  loadModels,
  type ModelInfo,
  memoryCredentialStore,
  type ProviderConfig,
  type ThinkingLevel,
  type VelaSession,
  verifyProviderModel,
  writeProviderPreset,
} from '@glows777/vela-core'
import { THINKING_LEVELS } from '@glows777/vela-core/diagnostics'
import type { Vela } from '../../vela.ts'
import { createVela } from '../../vela.ts'
import { openBrowser } from '../login.ts'

interface Host {
  vela: Vela
  session: VelaSession
  agentDir: string
  select(
    title: string,
    choices: SelectItem[],
    selected?: string,
  ): Promise<string | undefined>
  input(
    title: string,
    placeholder?: string,
    signal?: AbortSignal,
    secret?: boolean,
  ): Promise<string | undefined>
  addNotice(text: string, level?: 'info' | 'warning' | 'error' | 'dim'): void
  pickModel(models: ModelInfo[], current?: string): Promise<string | undefined>
  setSummary(text: string): void
  onConfigured?(): void
  openBrowser?: (url: string) => void
  signal?: AbortSignal
}

function readObject(path: string): Record<string, unknown> {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
}

/** One setup flow for first run and explicit `vela setup`. No credentials are persisted before verification. */
export async function setupWizard(host: Host): Promise<boolean> {
  const { agentDir } = host
  const settingsPath = join(agentDir, 'settings.json')
  const modelsPath = join(agentDir, 'models.json')
  const authPath = join(agentDir, 'auth.json')
  const settings = readObject(settingsPath)
  const modelsFile = readObject(modelsPath)
  if (typeof settings.defaultModel === 'string') {
    const name = settings.defaultModel.split('/')[0] ?? ''
    const definitions = (modelsFile.providers ?? {}) as Record<
      string,
      ProviderConfig
    >
    const credential = (await import('@glows777/vela-core'))
      .fileCredentialStore(authPath)
      .get(name)
    const current = await host.select(
      `Current model: ${settings.defaultModel} · thinking: ${settings.defaultThinkingLevel ?? 'medium'}\nCredential: ${credential ? 'saved' : 'not saved in auth.json'}${definitions[name]?.baseUrl ? ` · endpoint: ${definitions[name].baseUrl}` : ''}`,
      [
        { value: 'keep', label: 'Keep current configuration' },
        { value: 'change', label: 'Change configuration' },
      ],
    )
    if (!current) return false
    if (current === 'keep') {
      const summary = `No changes. Current configuration: ${settingsPath}`
      host.addNotice(summary)
      host.setSummary(summary)
      return true
    }
  }
  const choice = await host.select('Choose a provider', [
    { value: 'anthropic', label: 'Anthropic API key' },
    { value: 'openai-key', label: 'OpenAI API key' },
    { value: 'openai-oauth', label: 'Sign in with ChatGPT' },
    { value: 'openrouter', label: 'OpenRouter' },
    { value: 'deepseek', label: 'DeepSeek' },
    { value: 'other', label: 'Other OpenAI-compatible' },
  ])
  if (!choice) return false
  let provider = choice.startsWith('openai-') ? 'openai' : choice
  let preset: ProviderConfig | undefined
  if (
    choice === 'deepseek' &&
    !((modelsFile.providers ?? {}) as Record<string, unknown>).deepseek
  )
    preset = {
      api: 'openai-completions',
      baseUrl: 'https://api.deepseek.com',
      models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
    }
  if (choice === 'other') {
    const name = await host.input('Provider name', 'e.g. local')
    if (!name) return false
    provider = name
    const baseUrl = await host.input('Base URL', 'https://example.com/v1')
    if (!baseUrl) return false
    preset = { api: 'openai-completions', baseUrl }
  }
  const savedProviders = (modelsFile.providers ?? {}) as Record<
    string,
    ProviderConfig
  >
  const prior = savedProviders[provider] ?? {}
  const override = preset ? { ...prior, ...preset } : undefined
  const providers = loadModels({
    agentDir,
    env: process.env,
    ...(override ? { overrides: { [provider]: override } } : {}),
  })
  const existing = host.vela
    .loginProviders()
    .find((p) => p.provider === provider)
  const diskCredentials = (
    await import('@glows777/vela-core')
  ).fileCredentialStore(authPath)
  const stored = diskCredentials.get(provider)
  const memory = memoryCredentialStore(stored ? { [provider]: stored } : {})
  const temporary = createVela({
    providers,
    credentials: memory,
    cwd: host.vela.cwd,
  })
  let newCredential = false
  let newInstallationId: string | undefined
  try {
    const matchingCredential =
      stored &&
      (choice === 'openai-oauth'
        ? stored.type === 'oauth'
        : choice === 'openai-key'
          ? stored.type === 'api_key'
          : true)
    const keep = matchingCredential
      ? await host.select(`Credential for ${provider} is configured`, [
          { value: 'keep', label: 'Keep existing credential' },
          { value: 'replace', label: 'Replace credential' },
        ])
      : 'replace'
    if (!keep) return false
    if (keep === 'replace') {
      if (choice === 'deepseek' || choice === 'other') {
        const key = await host.input(
          `API key for ${provider}`,
          undefined,
          undefined,
          true,
        )
        if (!key) return false
        await memory.modify(provider, async () => ({ type: 'api_key', key }))
      } else {
        let method: 'api_key' | 'oauth' =
          choice === 'openai-oauth' ? 'oauth' : 'api_key'
        if (choice === 'openrouter' && existing?.oauth) {
          const selected = await host.select('OpenRouter sign in', [
            { value: 'api_key', label: 'Enter API key' },
            { value: 'oauth', label: existing.oauth },
          ])
          if (!selected) return false
          method = selected as 'api_key' | 'oauth'
        }
        const controller = new AbortController()
        host.signal?.addEventListener('abort', () => controller.abort(), {
          once: true,
        })
        const interaction: AuthInteraction = {
          signal: controller.signal,
          prompt: async (prompt) => {
            const answer =
              prompt.type === 'select'
                ? await host.select(
                    prompt.message,
                    prompt.options.map((o) => ({
                      value: o.id,
                      label: o.label,
                    })),
                  )
                : await host.input(
                    prompt.message,
                    prompt.placeholder,
                    prompt.signal,
                    prompt.type === 'secret',
                  )
            if (prompt.signal?.aborted) throw new Error('Prompt closed')
            if (!answer) {
              controller.abort()
              throw new Error('Login cancelled')
            }
            return answer
          },
          notify: (event) => {
            if (event.type === 'auth_url') {
              host.addNotice(
                `${event.instructions ?? 'Open this URL:'}\n${event.url}`,
              )
              ;(host.openBrowser ?? openBrowser)(event.url)
            } else host.addNotice(event.message, 'dim')
          },
        }
        const idPath = join(agentDir, 'installation-id')
        await temporary.login(provider, method, interaction, {
          getDeviceId: () => {
            if (existsSync(idPath)) return readFileSync(idPath, 'utf8').trim()
            newInstallationId ??= randomUUID()
            return newInstallationId
          },
        })
      }
      newCredential = true
    }
    let id: string | undefined
    if (choice === 'other') id = await host.input('Model ID', 'e.g. model-name')
    else {
      const candidates = temporary
        .models({ all: true })
        .filter((m) => m.provider === provider)
      const selected = await host.pickModel(
        candidates,
        typeof settings.defaultModel === 'string'
          ? settings.defaultModel
          : undefined,
      )
      id = selected?.slice(provider.length + 1)
    }
    if (!id) return false
    if (preset && choice === 'other') {
      const previous = prior.models ?? []
      preset.models = previous.some((model) => model.id === id)
        ? previous
        : [...previous, { id }]
    }
    const finalOverride = preset ? { ...prior, ...preset } : undefined
    const finalProviders = loadModels({
      agentDir,
      env: process.env,
      ...(finalOverride ? { overrides: { [provider]: finalOverride } } : {}),
    })
    const ref = `${provider}/${id}`
    const proceed = await host.select(
      'Verification sends a minimal request and may incur a small charge',
      [
        { value: 'yes', label: 'Verify' },
        { value: 'no', label: 'Cancel' },
      ],
    )
    if (proceed !== 'yes') return false
    for (;;) {
      if (
        !newCredential &&
        stored?.type === 'oauth' &&
        stored.expires <= Date.now() + 310_000
      ) {
        host.addNotice(
          'The saved sign-in is close to expiry. Rerun setup and select Replace credential before verifying.',
          'warning',
        )
        await host.select('Saved sign-in needs renewal', [
          { value: 'cancel', label: 'Cancel and rerun setup' },
        ])
        return false
      }
      try {
        await verifyProviderModel(ref, finalProviders, memory, host.signal)
        break
      } catch (error) {
        if (host.signal?.aborted) return false
        const message = error instanceof Error ? error.message : String(error)
        host.addNotice(`Verification failed: ${message}`, 'error')
        const retry = await host.select(`Verification failed: ${message}`, [
          { value: 'retry', label: 'Retry verification' },
          { value: 'cancel', label: 'Cancel and rerun setup' },
        ])
        if (retry !== 'retry') return false
      }
    }
    const model = temporary
      .models({ all: true })
      .find((m) => m.provider === provider && m.id === id)
    const levels =
      model?.reasoning === false
        ? ['off']
        : THINKING_LEVELS.filter(
            (level) =>
              !model ||
              model.reasoning === undefined ||
              (model.thinkingLevelMap?.[level] !== null &&
                (!['xhigh', 'max'].includes(level) ||
                  model.thinkingLevelMap?.[level] !== undefined)),
          )
    const thinking = await host.select(
      'Thinking level',
      levels.map((level) => ({ value: level, label: level })),
      typeof settings.defaultThinkingLevel === 'string'
        ? settings.defaultThinkingLevel
        : 'medium',
    )
    if (!thinking) return false
    const lark = await host.select('Connect Lark?', [
      { value: 'yes', label: 'Yes, show connection information' },
      { value: 'later', label: 'Not now' },
    ])
    if (!lark) return false
    const larkNote =
      lark === 'yes'
        ? 'Lark setup is coming soon. Manual setup: https://github.com/glows777/Vela/blob/main/docs/channels.md#lark'
        : ''
    if (larkNote) host.addNotice(larkNote)
    const save = await host.select(
      `Save configuration for ${ref}\nThinking: ${thinking}\nCredentials: ${authPath}\nModels: ${modelsPath}\nSettings: ${settingsPath}`,
      [
        { value: 'yes', label: 'Save configuration' },
        { value: 'no', label: 'Cancel' },
      ],
    )
    if (save !== 'yes') return false
    const written: string[] = []
    try {
      if (
        newCredential ||
        JSON.stringify(memory.get(provider)) !== JSON.stringify(stored)
      ) {
        await diskCredentials.modify(provider, async () => memory.get(provider))
        written.push(authPath)
      }
      mkdirSync(agentDir, { recursive: true, mode: 0o700 })
      if (newInstallationId) {
        writeFileSync(
          join(agentDir, 'installation-id'),
          `${newInstallationId}\n`,
        )
        written.push(join(agentDir, 'installation-id'))
      }
      if (finalOverride) {
        writeProviderPreset(agentDir, provider, finalOverride)
        written.push(modelsPath)
      }
      settings.defaultModel = ref
      settings.defaultThinkingLevel = thinking
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
      written.push(settingsPath)
      host.vela.configureProvider(provider, finalProviders[provider]!)
      host.vela.setDefaults(ref, thinking as ThinkingLevel)
      host.session.setModel(ref)
      host.session.setThinkingLevel(thinking as ThinkingLevel)
      host.onConfigured?.()
      const summary = `Saved:\n${written.join('\n')}\nChange these files later or run vela setup again.${larkNote ? `\n${larkNote}` : ''}`
      host.addNotice(summary)
      host.setSummary(summary)
      return true
    } catch (error) {
      const summary = `Setup failed: ${error instanceof Error ? error.message : String(error)}\nAlready written: ${written.join(', ') || 'none'}`
      host.addNotice(summary, 'error')
      host.setSummary(summary)
      return false
    }
  } finally {
    await temporary.dispose()
  }
}
