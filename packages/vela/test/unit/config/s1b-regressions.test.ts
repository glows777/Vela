import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../../../../../test/support/vela.ts'
import { PROJECT_PRIVILEGED_KEYS } from '../../../src/config/index.ts'
import { discoverExtensions } from '../../../src/driver/config/extension-discovery.ts'
import { importExtension } from '../../../src/driver/config/extensions.ts'
import {
  fileCredentialStore,
  memoryCredentialStore,
} from '../../../src/driver/index.ts'
import { loadConfig, loadModels } from '../../../src/load-config.ts'
import type { CallbackServer } from '../../../src/providers/auth/oauth/callback-server.ts'
import { waitForCallbackOrPaste } from '../../../src/providers/auth/oauth/callback-server.ts'
import { openaiChatGPTLogin } from '../../../src/providers/auth/oauth/openai-chatgpt.ts'
import { ModelRegistry } from '../../../src/providers/models/index.ts'
import { writeProviderPreset } from '../../../src/providers/models/setup.ts'

const dirs: { cleanup(): void }[] = []
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  for (const dir of dirs.splice(0)) dir.cleanup()
})

function setupProject(
  userConfig?: Record<string, unknown>,
  projectConfig?: Record<string, unknown>,
) {
  const root = tempDir('vela-s1b-reg-')
  dirs.push(root)
  const agentDir = join(root.path, 'agent')
  const cwd = join(root.path, 'project')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(join(cwd, '.vela'), { recursive: true })
  if (userConfig !== undefined)
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify(userConfig))
  if (projectConfig !== undefined)
    writeFileSync(
      join(cwd, '.vela', 'config.json'),
      JSON.stringify(projectConfig),
    )
  return { root: root.path, agentDir, cwd }
}

test('detectLegacyConfigFiles errors clearly until config.json exists', () => {
  for (const legacy of ['settings.json', 'models.json', 'mcp.json']) {
    const { agentDir, cwd } = setupProject()
    writeFileSync(join(agentDir, legacy), '{}')
    expect(() => loadConfig({ cwd, agentDir })).toThrow(
      new RegExp(
        `found legacy config file\\(s\\).*${legacy}.*unified config\\.json`,
      ),
    )
    writeFileSync(join(agentDir, 'config.json'), '{}')
    expect(() => loadConfig({ cwd, agentDir })).not.toThrow()
  }
})

test('all privileged keys are stripped from project .vela/config.json', () => {
  const { agentDir, cwd } = setupProject(
    {
      model: 'openai/gpt-5.5',
      environments: { dev: { image: 'user-image' } },
      location: { environment: 'dev' },
      providers: {
        custom: { api: 'openai-completions', models: [{ id: 'm' }] },
      },
      lark: { appId: 'user-app' },
      local: { enabled: true, token: 'user-tok' },
      webhooks: { port: 8000 },
      eventDefaultTarget: { channel: 'lark', chatId: 'user-chat' },
    },
    {
      environments: { dev: { image: 'evil-image' } },
      location: { environment: 'evil' },
      providers: {
        custom: { api: 'anthropic-messages', models: [{ id: 'evil' }] },
      },
      lark: { appId: 'evil-app' },
      local: { enabled: false, token: 'evil-tok' },
      webhooks: { port: 9999 },
      eventDefaultTarget: { channel: 'lark', chatId: 'evil-chat' },
      thinkingLevel: 'high',
    },
  )
  expect(PROJECT_PRIVILEGED_KEYS).toEqual([
    'environments',
    'location',
    'providers',
    'lark',
    'local',
    'webhooks',
    'eventDefaultTarget',
  ])
  const loaded = loadConfig({ cwd, agentDir, trusted: true })
  expect(loaded.settings.thinkingLevel).toBe('high')
  expect(loaded.settings.environments).toEqual({ dev: { image: 'user-image' } })
  expect(loaded.settings.location).toEqual({ environment: 'dev' })
  expect(loaded.settings.lark).toEqual({ appId: 'user-app' })
  expect(loaded.settings.local).toEqual({ enabled: true, token: 'user-tok' })
  expect(loaded.settings.webhooks).toEqual({ port: 8000 })
  expect(loaded.settings.eventDefaultTarget).toEqual({
    channel: 'lark',
    chatId: 'user-chat',
  })
  expect(loaded.providers.custom?.models?.map((m) => m.id)).toEqual(['m'])
})

test('Fix #1: $VAR expansion runs single-pass per layer and keeps environments literal', () => {
  const { agentDir, cwd } = setupProject(
    {
      web: { tavilyKey: '$KEY' },
      environments: {
        box: {
          image: 'ubuntu:24.04',
          credentials: {
            GH_TOKEN: { value: '$GH_TOKEN', origins: ['https://github.com'] },
          },
        },
      },
    },
    {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing $VAR non-recursive expansion
      web: { serperKey: '${SECOND_HOLDER}' },
    },
  )
  const config = loadConfig({
    cwd,
    agentDir,
    trusted: true,
    env: {
      KEY: 'first-$SECOND',
      SECOND_HOLDER: 'pwned-$SECOND',
      SECOND: 'MUST_NOT_EXPAND',
      GH_TOKEN: 'secret-token',
    },
  })
  expect(config.extensionConfig.web).toEqual({
    tavilyKey: 'first-$SECOND',
    serperKey: 'pwned-$SECOND',
  })
  expect(
    (
      config.settings.environments?.box as
        | { credentials: { GH_TOKEN: { value: string } } }
        | undefined
    )?.credentials.GH_TOKEN.value,
  ).toBe('$GH_TOKEN')
})

test('Fix #2: expired ChatGPT OAuth falls back to API key in channel sessions without refresh or ChatGPT transform', async () => {
  const requests: {
    url: string
    auth: string | null
    body: Record<string, unknown>
  }[] = []
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input)
    if (url.includes('/oauth/token'))
      throw new Error('OAuth refresh must not run on channel fallback')
    const body = JSON.parse(String(init?.body))
    requests.push({
      url,
      auth: new Headers(init?.headers).get('authorization'),
      body,
    })
    return new Response('{"error":{"message":"stub"}}', { status: 400 })
  }) as typeof fetch

  for (const source of ['env', 'config'] as const) {
    const { agentDir } = setupProject(
      source === 'config'
        ? { providers: { openai: { apiKey: 'cfg-openai-key' } } }
        : undefined,
    )
    const providers = loadModels({
      agentDir,
      env: source === 'env' ? { OPENAI_API_KEY: 'env-openai-key' } : {},
    })
    const registry = new ModelRegistry(
      providers,
      memoryCredentialStore({
        openai: {
          type: 'oauth',
          access: 'expired-chatgpt-token',
          refresh: 'refresh-tok',
          expires: Date.now() - 60_000,
          clientId: 'oaiapp_1',
        },
      }),
    )
    const resolved = registry.resolve('openai/gpt-4.1', {
      channel: () => 'lark',
    })
    await (
      resolved.model as unknown as {
        doGenerate(options: unknown): Promise<unknown>
      }
    )
      .doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        temperature: 0.2,
      })
      .catch(() => {})
    const expected = source === 'env' ? 'env-openai-key' : 'cfg-openai-key'
    expect(requests.at(-1)?.auth).toBe(`Bearer ${expected}`)
    expect(requests.at(-1)?.body.temperature).toBe(0.2)
    expect(requests.at(-1)?.body.include).toBeUndefined()
  }

  // Without any API key fallback, channel sessions still refuse local-only OAuth.
  const { agentDir } = setupProject()
  const noFallback = new ModelRegistry(
    loadModels({ agentDir, env: {} }),
    memoryCredentialStore({
      openai: {
        type: 'oauth',
        access: 'expired-chatgpt-token',
        refresh: 'refresh-tok',
        expires: Date.now() - 60_000,
        clientId: 'oaiapp_1',
      },
    }),
  )
  await expect(
    (
      noFallback.resolve('openai/gpt-5.5', { channel: () => 'lark' })
        .model as unknown as { doGenerate(options: unknown): Promise<unknown> }
    ).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }),
  ).rejects.toThrow('only for the local terminal, not for lark')
})

test('Fix #3: auth.json.lock respects ownership token on stale takeover and writeProviderPreset writes 0600 config.json', async () => {
  const { agentDir } = setupProject()
  const authPath = join(agentDir, 'auth.json')
  const lockPath = `${authPath}.lock`
  writeFileSync(lockPath, 'dead-pid:stale-token')
  const old = new Date(Date.now() - 60_000)
  utimesSync(lockPath, old, old)

  const store = fileCredentialStore(authPath)
  await store.modify('openai', async () => {
    // Simulate a second process legitimately taking over after lock replacement.
    writeFileSync(lockPath, 'other-pid:foreign-token')
    return { type: 'api_key', key: 'k1' }
  })
  expect(existsSync(lockPath)).toBe(true)
  expect(readFileSync(lockPath, 'utf8')).toBe('other-pid:foreign-token')
  expect(statSync(authPath).mode & 0o777).toBe(0o600)

  const presetPath = writeProviderPreset(agentDir, 'custom', {
    api: 'openai-completions',
    baseUrl: 'https://example.invalid/v1',
    models: [{ id: 'm1' }],
  })
  expect(presetPath).toBe(join(agentDir, 'config.json'))
  expect(statSync(presetPath).mode & 0o777).toBe(0o600)
  expect(statSync(agentDir).mode & 0o777).toBe(0o700)
  expect(readdirSync(agentDir).filter((name) => name.endsWith('.tmp'))).toEqual(
    [],
  )
})

test('Fix #3: ChatGPT OAuth refresh accepts omitted refresh_token/scope and callback beats delayed manual error', async () => {
  globalThis.fetch = (async () =>
    Response.json({
      access_token: 'fresh-access',
      expires_in: 3600,
    })) as unknown as typeof fetch

  const refreshed = await openaiChatGPTLogin.refresh!(
    {
      type: 'oauth',
      access: 'old-access',
      refresh: 'original-refresh',
      expires: 0,
      clientId: 'oaiapp_1',
    },
    new AbortController().signal,
  )
  expect(refreshed.access).toBe('fresh-access')
  expect(refreshed.refresh).toBe('original-refresh')

  // Simulate a claimed browser callback whose completion resolves slightly after manual prompt errors.
  const server: CallbackServer<string> = {
    redirectUri: 'http://127.0.0.1:1455/auth/callback',
    wait: () =>
      new Promise((resolve) => setTimeout(() => resolve('ok-code'), 15)),
    cancel: () => {},
    close: () => {},
  }
  const result = await waitForCallbackOrPaste(
    {
      signal: new AbortController().signal,
      prompt: async () => {
        throw new Error('stdin closed')
      },
      notify: () => {},
    },
    server,
    { message: 'Paste URL', placeholder: 'http://...' },
  )
  expect(result).toEqual({ type: 'callback', value: 'ok-code' })
})

test('Fix #4: discoverExtensions follows valid symlinks, skips broken symlinks, and jiti loads standalone TS extensions', async () => {
  const dir = tempDir('vela-symlinks-')
  dirs.push(dir)
  const targetDir = join(dir.path, 'targets')
  const extDir = join(dir.path, 'extensions')
  mkdirSync(join(targetDir, 'linked-pkg'), { recursive: true })
  mkdirSync(extDir, { recursive: true })

  const directTarget = join(targetDir, 'linked.ts')
  writeFileSync(
    directTarget,
    `import { z } from 'zod'
import { createJsonSchema, defineJsonSchemaTool } from '@glows777/vela'
import type { ExtensionAPI } from '@glows777/vela/extension-api'
export default function (api: ExtensionAPI) {
  api.registerTool(defineJsonSchemaTool({
    name: 'probe',
    description: 'probe',
    inputSchema: createJsonSchema(z.object({ ok: z.boolean() })),
    execute: async () => 'ok',
  }))
}
`,
  )
  writeFileSync(
    join(targetDir, 'linked-pkg', 'index.ts'),
    'export default () => {}\n',
  )
  symlinkSync(directTarget, join(extDir, 'linked.ts'))
  symlinkSync(join(targetDir, 'linked-pkg'), join(extDir, 'linked-pkg'))
  symlinkSync(join(targetDir, 'missing.ts'), join(extDir, 'broken.ts'))

  const discovered = discoverExtensions(extDir)
  expect(discovered).toEqual([
    join(extDir, 'linked-pkg', 'index.ts'),
    join(extDir, 'linked.ts'),
  ])

  const factory = await importExtension(discovered[1]!, 'linked')
  expect(factory.name).toBe('linked')
  const registered: string[] = []
  await factory({
    registerTool(tool) {
      registered.push(tool.name)
    },
  } as Parameters<typeof factory>[0])
  expect(registered).toEqual(['probe'])
})
