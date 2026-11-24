import { afterEach, expect, test } from 'bun:test'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { Footer } from '../../../src/cli/tui/footer.ts'
import { createVela, type Vela } from '../../../src/driver/vela.ts'
import { memoryCredentialStore } from '../../../src/providers/auth/store.ts'
import type {
  Credential,
  OAuthLogin,
} from '../../../src/providers/auth/types.ts'
import { createFauxModel } from '../../../src/testing/core/faux.ts'

const REF = 'plan/gpt-6.2-sol'

const planLogin: OAuthLogin = {
  name: 'Sign in with a plan',
  isSubscription: true,
  planLabel: 'ChatGPT plan',
  login: async () => ({ type: 'api_key', key: 'k' }),
}

const open: Vela[] = []
afterEach(async () => {
  for (const vela of open.splice(0)) await vela.dispose()
})

/** The rendered footer of a session at `medium`, funded by `credential` (undefined for no credential) */
function render(credential: Credential | undefined): string {
  const vela = createVela({
    model: REF,
    credentials: memoryCredentialStore(credential ? { plan: credential } : {}),
    providers: {
      plan: {
        models: [{ id: 'gpt-6.2-sol' }],
        oauth: planLogin,
        createModel: () => createFauxModel(),
      },
    },
  })
  open.push(vela)
  const session = vela.session('footer')
  const lines = new Footer(vela.cwd, () => session).render(120)
  return stripTerminalSequences(lines.join('\n'))
}

test('the footer names the plan paying for a subscription session', () => {
  const screen = render({
    type: 'oauth',
    access: 'a',
    refresh: 'r',
    expires: 0,
  })
  expect(screen).toContain(`${REF} · medium · ChatGPT plan`)
})

test('an API key session shows no plan', () => {
  const screen = render({ type: 'api_key', key: 'k' })
  expect(screen).toContain(`${REF} · medium`)
  expect(screen).not.toContain('ChatGPT plan')
})
