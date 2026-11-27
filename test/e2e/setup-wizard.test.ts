import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliSessionClient } from '../../packages/vela/src/cli/runtime-client.ts'
import { setupWizard } from '../../packages/vela/src/cli/tui/setup-wizard.ts'
import { fileCredentialStore } from '../../packages/vela/src/driver/index.ts'
import {
  createRuntime,
  loadModels,
  memoryCredentialStore,
  verifyProviderModel,
} from '../../packages/vela/src/index.ts'
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
      runtime: {
        loginProviders: async () => [
          { provider: 'openrouter', oauth: 'OpenRouter' },
        ],
        oauthRegistrations: {
          get: async () => undefined,
          set: async () => {},
          delete: async () => false,
        },
        reloadConfig: async () => {},
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

test('setup preserves an existing custom DeepSeek provider and applies its defaults to new sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vela-setup-session-'))
  const configPath = join(dir, 'config.json')
  const originalProviders = {
    deepseek: {
      api: 'openai-completions',
      baseUrl: 'https://custom.example/v1',
      headers: { 'x-custom': 'preserved' },
      models: [{ id: 'deepseek-reasoner' }],
    },
  }
  writeFileSync(
    configPath,
    JSON.stringify({ providers: originalProviders }, null, 4),
  )
  const runtime = createRuntime({ agentDir: dir, hostEnv: {} })
  await runtime.ready()
  const project = await runtime.projects.create({ name: 'test', cwd: dir })
  const initial = await runtime.sessions.create({
    id: 'initial',
    projectId: project.id,
  })
  const session = new CliSessionClient(
    runtime,
    initial.id,
    await runtime.sessions.inspect(initial.id),
  )
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
      runtime,
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
    const nextRecord = await runtime.sessions.create({
      id: 'new',
      projectId: project.id,
    })
    const next = await runtime.sessions.inspect(nextRecord.id)
    expect(saved).toBe(true)
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      providers: originalProviders,
      model: 'deepseek/deepseek-reasoner',
      thinkingLevel: 'high',
    })
    expect(next.modelInfo?.ref).toBe('deepseek/deepseek-reasoner')
    expect(next.thinkingLevel).toBe('high')
  } finally {
    globalThis.fetch = originalFetch
    await runtime.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('empty-home DeepSeek setup uses the built-in Responses provider for its first answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vela-setup-deepseek-'))
  const authPath = join(dir, 'auth.json')
  const runtime = createRuntime({ agentDir: dir, hostEnv: {} })
  await runtime.ready()
  const project = await runtime.projects.create({ name: 'test', cwd: dir })
  const initial = await runtime.sessions.create({
    id: 'initial',
    projectId: project.id,
  })
  const session = new CliSessionClient(
    runtime,
    initial.id,
    await runtime.sessions.inspect(initial.id),
  )
  const originalFetch = globalThis.fetch
  const requests: {
    url: string
    body: { model: string; stream?: boolean }
    authorization: string | null
  }[] = []
  globalThis.fetch = (async (input, init) => {
    const body = JSON.parse(String(init?.body))
    requests.push({
      url: String(input),
      body,
      authorization: new Headers(init?.headers).get('authorization'),
    })
    return responsesReply(body)
  }) as typeof fetch
  try {
    const saved = await setupWizard({
      runtime,
      session,
      agentDir: dir,
      select: async (title) =>
        title === 'Choose a provider'
          ? 'deepseek'
          : title === 'Thinking level'
            ? 'high'
            : title === 'Connect Lark?'
              ? 'later'
              : title.startsWith('Verification failed')
                ? 'cancel'
                : 'yes',
      input: async () => 'fake-deepseek-key',
      pickModel: async (models) => {
        expect(models.some((model) => model.id === 'deepseek-flash')).toBe(true)
        expect(models.some((model) => model.id === 'deepseek-v4-pro')).toBe(
          true,
        )
        expect(models.some((model) => model.id === 'deepseek-chat')).toBe(false)
        return 'deepseek/deepseek-flash'
      },
      addNotice: () => {},
      setSummary: () => {},
    })
    expect(saved).toBe(true)
    expect(existsSync(join(dir, 'models.json'))).toBe(false)
    expect(fileCredentialStore(authPath).get('deepseek')).toEqual({
      type: 'api_key',
      key: 'fake-deepseek-key',
    })
    expect(
      JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')),
    ).toMatchObject({
      model: 'deepseek/deepseek-flash',
      thinkingLevel: 'high',
    })
    expect(statSync(join(dir, 'config.json')).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    await session.refresh()
    expect(session.modelInfo?.ref).toBe('deepseek/deepseek-flash')
    const nextRecord = await runtime.sessions.create({
      id: 'new',
      projectId: project.id,
    })
    const next = await runtime.sessions.inspect(nextRecord.id)
    expect(next.modelInfo?.ref).toBe('deepseek/deepseek-flash')
    expect(next.thinkingLevel).toBe('high')
    await runtime.prompt(initial.id, { text: 'Hello DeepSeek' })
    await runtime.waitForIdle(initial.id)
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.url).toBe('https://api.deepseek.com/responses')
      expect(request.body.model).toBe('deepseek-flash')
      expect(request.authorization).toBe('Bearer fake-deepseek-key')
    }
    expect(requests[1]!.body.stream).toBe(true)
    const page = await runtime.sessions.messages({ sessionId: initial.id })
    expect(
      page.messages.some(
        (record) =>
          record.role === 'assistant' &&
          JSON.stringify(record.content).includes('OK'),
      ),
    ).toBe(true)
  } finally {
    globalThis.fetch = originalFetch
    await runtime.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
