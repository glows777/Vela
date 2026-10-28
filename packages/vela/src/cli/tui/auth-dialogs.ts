import type { SelectItem } from '@earendil-works/pi-tui'
import type {
  AuthInteraction,
  AuthPrompt,
  LoginOptions,
} from '@glows777/vela-core'
import type { Vela } from '../../vela.ts'
import { openBrowser } from '../login.ts'
import { errorMessage } from './components.ts'

interface AuthHost {
  vela: Vela
  options: { openBrowser?: (url: string) => void; loginOptions?: LoginOptions }
  select(
    title: string,
    items: SelectItem[],
    selected?: string,
  ): Promise<string | undefined>
  input(
    title: string,
    placeholder?: string,
    signal?: AbortSignal,
    secret?: boolean,
  ): Promise<string | undefined>
  addNotice(text: string, level?: 'info' | 'warning' | 'error' | 'dim'): void
  renderHeader(modelOk: boolean): void
}

/** `/login [provider]` (like pi): pick a provider and a method, then run its sign-in or ask for an API key */
export async function loginCommand(
  host: AuthHost,
  args: string,
): Promise<void> {
  const providers = host.vela.loginProviders()
  let provider = args.trim() || undefined
  if (!provider) {
    if (!providers.length) {
      host.addNotice('No provider supports /login', 'dim')
      return
    }
    provider = await host.select(
      'Sign in to',
      providers.map((p) => ({
        value: p.provider,
        label: p.provider,
        description: [p.oauth, p.source && `using ${p.source}`]
          .filter(Boolean)
          .join(' · '),
      })),
    )
    if (!provider) return
  }
  const found = providers.find((p) => p.provider === provider)
  if (!found) {
    host.addNotice(
      `Unknown provider ${provider} (can sign in to: ${providers.map((p) => p.provider).join(', ') || 'none'})`,
      'error',
    )
    return
  }
  const methods = [
    ...(found.oauth ? [{ value: 'oauth', label: found.oauth }] : []),
    ...(found.apiKey ? [{ value: 'api_key', label: 'Enter an API key' }] : []),
  ]
  const method =
    methods.length === 1
      ? methods[0]?.value
      : await host.select(`Sign in to ${provider}`, methods)
  if (method !== 'oauth' && method !== 'api_key') return
  const controller = new AbortController()
  const interaction: AuthInteraction = {
    signal: controller.signal,
    prompt: (prompt) => authPrompt(host, prompt, controller),
    notify: (event) => {
      if (event.type === 'auth_url') {
        host.addNotice(
          `${event.instructions ?? 'Open this URL to sign in:'}\n${event.url}`,
          'info',
        )
        ;(host.options.openBrowser ?? openBrowser)(event.url)
      } else host.addNotice(event.message, 'dim')
    },
  }
  try {
    await host.vela.login(
      provider,
      method,
      interaction,
      host.options.loginOptions,
    )
    host.addNotice(
      `Signed in to ${provider}; the credential is saved for later sessions`,
      'info',
    )
  } catch (error) {
    host.addNotice(
      controller.signal.aborted
        ? 'Login cancelled'
        : `Login to ${provider} failed: ${errorMessage(error)}`,
      controller.signal.aborted ? 'dim' : 'error',
    )
  } finally {
    controller.abort()
  }
  host.renderHeader(true)
}

/** One login question as a dialog; Esc cancels the whole login, the prompt's own signal closes just the dialog */
async function authPrompt(
  host: AuthHost,
  prompt: AuthPrompt,
  login: AbortController,
): Promise<string> {
  let answer: string | undefined
  if (prompt.type === 'select')
    answer = await host.select(
      prompt.message,
      prompt.options.map((o) => ({ value: o.id, label: o.label })),
    )
  else
    answer = await host.input(
      prompt.message,
      prompt.placeholder,
      prompt.signal,
      prompt.type === 'secret',
    )
  if (prompt.signal?.aborted) throw new Error('Prompt closed')
  if (answer === undefined) {
    login.abort()
    throw new Error('Login cancelled')
  }
  return answer
}

/** `/logout [provider]`: removes the stored credential (environment variables and models.json keys stay) */
export async function logoutCommand(
  host: AuthHost,
  args: string,
): Promise<void> {
  const stored = host.vela
    .loginProviders()
    .filter((p) => p.source === 'auth.json' || p.source === 'OAuth (auth.json)')
  const provider =
    args.trim() ||
    (stored.length
      ? await host.select(
          'Sign out of',
          stored.map((p) => ({ value: p.provider, label: p.provider })),
        )
      : undefined)
  if (!provider) {
    if (!stored.length) host.addNotice('No stored credentials', 'dim')
    return
  }
  try {
    host.addNotice(
      (await host.vela.logout(provider))
        ? `Removed the stored credential for ${provider}`
        : `No stored credential for ${provider}`,
      'dim',
    )
  } catch (error) {
    host.addNotice(errorMessage(error), 'error')
  }
  host.renderHeader(true)
}
