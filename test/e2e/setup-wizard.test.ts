import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fileCredentialStore,
  loadModels,
  memoryCredentialStore,
  verifyProviderModel,
} from '@glows777/vela-core'
import { setupWizard } from '../../packages/vela/src/cli/tui/setup-wizard.ts'
import { createVela } from '../../packages/vela/src/vela.ts'
import { responsesReply } from '../support/responses.ts'

test('OpenAI setup verification uses a Responses-compatible output limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vela-setup-openai-'))
  const original = globalThis.fetch
  let outputLimit = 0
  globalThis.fetch = (async (
    _input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const body = JSON.parse(String(init?.body))
    outputLimit = body.max_output_tokens
    return outputLimit < 16
      ? Response.json(
          { error: { message: 'max_output_tokens must be at least 16' } },
          { status: 400 },
        )
      : responsesReply(body)
  }) as unknown as typeof fetch
  try {
    await verifyProviderModel(
      'openai/gpt-5.5',
      loadModels({ agentDir: dir }),
      memoryCredentialStore({ openai: { type: 'api_key', key: 'fake' } }),
    )
    expect(outputLimit).toBeGreaterThanOrEqual(16)
  } finally {
    globalThis.fetch = original
    rmSync(dir, { recursive: true, force: true })
  }
})

test('setup preserves a successful browser callback when the paste prompt closes', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) =>
    String(input) === 'https://openrouter.ai/api/v1/auth/keys'
      ? Promise.resolve(Response.json({ key: 'fake-key' }))
      : originalFetch(input, init)) as typeof fetch
  let reachedModelPicker = false
  try {
    await setupWizard({
      agentDir: join(tmpdir(), `vela-oauth-callback-${process.pid}`),
      vela: {
        cwd: tmpdir(),
        loginProviders: () => [{ provider: 'openrouter', oauth: 'OpenRouter' }],
      },
      session: {},
      select: async (title: string) =>
        title === 'Choose a provider'
          ? 'openrouter'
          : title === 'OpenRouter sign in'
            ? 'oauth'
            : undefined,
      input: async (
        _title: string,
        _placeholder: string,
        signal: AbortSignal,
      ) =>
        new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve(undefined), {
            once: true,
          }),
        ),
      addNotice: () => {},
      setSummary: () => {},
      pickModel: async () => {
        reachedModelPicker = true
        return undefined
      },
      openBrowser: (url: string) => {
        const callback = new URL(new URL(url).searchParams.get('callback_url')!)
        callback.searchParams.set('code', 'fake-code')
        setTimeout(() => void originalFetch(callback), 10)
      },
    } as unknown as Parameters<typeof setupWizard>[0])
    expect(reachedModelPicker).toBe(true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('saved setup defaults apply to a new session in the same process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vela-setup-session-'))
  const vela = createVela({
    cwd: dir,
    providers: loadModels({ agentDir: dir }),
    credentials: fileCredentialStore(join(dir, 'auth.json')),
  })
  const session = vela.session('initial')
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    Response.json({
      id: 'fake',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-reasoner',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'OK' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })) as unknown as typeof fetch
  try {
    const saved = await setupWizard({
      vela,
      session,
      agentDir: dir,
      select: async (title) =>
        title === 'Choose a provider'
          ? 'deepseek'
          : title === 'Thinking level'
            ? 'high'
            : title === 'Connect Lark?'
              ? 'later'
              : 'yes',
      input: async () => 'fake-key',
      pickModel: async () => 'deepseek/deepseek-reasoner',
      addNotice: () => {},
      setSummary: () => {},
    })
    const next = vela.session('new')
    expect(saved).toBe(true)
    expect(next.modelInfo.ref).toBe('deepseek/deepseek-reasoner')
    expect(next.thinkingLevel).toBe('high')
  } finally {
    globalThis.fetch = originalFetch
    await vela.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
