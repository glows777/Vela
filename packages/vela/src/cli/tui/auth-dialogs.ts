import type {
  AuthInteraction,
  AuthPrompt,
  LoginOptions,
} from '../../driver/index.ts'
import type { Vela } from '../../vela.ts'
import { openBrowser } from '../login.ts'
import { type DialogHost, errorMessage } from './components.ts'

interface AuthHost extends DialogHost {
  vela: Vela
  options: { openBrowser?: (url: string) => void; loginOptions?: LoginOptions }
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

/** `/logout [provider] [--forget]`: removes the stored credential, revoking the provider's session first where it can
 * (environment variables and config.json keys stay; `--forget` also clears retained OAuth registration) */
export async function logoutCommand(
  host: AuthHost,
  args: string,
): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const forget = tokens.includes('--forget')
  const requested = tokens.find((token) => token !== '--forget')
  const providers = host.vela.loginProviders()
  const isStoredCredential = (p: (typeof providers)[number]) =>
    p.source === 'auth.json' || p.source === 'OAuth (auth.json)'
  const stored = providers.filter(isStoredCredential)
  const candidates = forget
    ? providers.filter(
        (p) =>
          isStoredCredential(p) ||
          p.hasRegistration ||
          (stored.length === 0 && Boolean(p.oauth)),
      )
    : stored
  const provider =
    requested ||
    (candidates.length
      ? await host.select(
          forget ? 'Sign out and forget registration of' : 'Sign out of',
          candidates.map((p) => ({
            value: p.provider,
            label: p.provider,
            ...(!isStoredCredential(p) && p.hasRegistration
              ? { description: 'saved OAuth registration' }
              : p.source
                ? { description: p.source }
                : {}),
          })),
        )
      : undefined)
  if (!provider) {
    if (!candidates.length) {
      host.addNotice(
        forget
          ? 'No stored credentials or saved registrations'
          : 'No stored credentials',
        'dim',
      )
    }
    return
  }
  try {
    const result = await host.vela.logout(provider, { forget })
    if (result.notice) host.addNotice(result.notice, 'dim')
    if (result.removed && result.forgotten) {
      host.addNotice(
        `Removed the stored credential and cleared saved registration for ${provider}`,
        'dim',
      )
    } else if (result.removed) {
      host.addNotice(`Removed the stored credential for ${provider}`, 'dim')
    } else if (result.forgotten) {
      host.addNotice(`Cleared saved registration for ${provider}`, 'dim')
    } else {
      host.addNotice(`No stored credential for ${provider}`, 'dim')
    }
  } catch (error) {
    host.addNotice(errorMessage(error), 'error')
  }
  host.renderHeader(true)
}
