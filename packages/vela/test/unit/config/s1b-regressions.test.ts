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
import { githubSetup } from '../../../src/cli/github-setup.ts'

const BUILTIN_NAMES = ['background', 'memory', 'web', 'lark', 'mcp', 'todo']

import {
  PROJECT_PRIVILEGED_KEYS,
  parseConfig,
  readRawConfigFile,
} from '../../../src/config/index.ts'
import { discoverExtensions } from '../../../src/driver/config/extension-discovery.ts'
import { importExtension } from '../../../src/driver/config/extensions.ts'
import { loadProjectSettings } from '../../../src/driver/config/project-settings.ts'
import { projectTrustRequired } from '../../../src/driver/config/settings.ts'
import {
  createLocalExecutionEnv,
  fileCredentialStore,
  memoryCredentialStore,
} from '../../../src/driver/index.ts'
import { loadConfig, loadModels } from '../../../src/load-config.ts'
import { loadMcpServers } from '../../../src/mcp/config.ts'
import type { CallbackServer } from '../../../src/providers/auth/oauth/callback-server.ts'
import { waitForCallbackOrPaste } from '../../../src/providers/auth/oauth/callback-server.ts'
import { openaiChatGPTLogin } from '../../../src/providers/auth/oauth/openai-chatgpt.ts'
import { ModelRegistry } from '../../../src/providers/models/index.ts'
import { writeProviderPreset } from '../../../src/providers/models/setup.ts'
import { saveLarkSection, saveModelSetup } from '../../../src/settings.ts'

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

test('Fix #3: auth.json.lock recovers stale locks, blocks superseded commits, and writeProviderPreset writes 0600 config.json', async () => {
  const { agentDir } = setupProject()
  const authPath = join(agentDir, 'auth.json')
  const lockPath = `${authPath}.lock`
  writeFileSync(lockPath, 'dead-pid:stale-token')
  const old = new Date(Date.now() - 60_000)
  utimesSync(lockPath, old, old)

  const store = fileCredentialStore(authPath)
  await store.modify('openai', async () => ({
    type: 'api_key',
    key: 'fresh-key',
  }))
  expect(existsSync(lockPath)).toBe(false)
  expect(statSync(authPath).mode & 0o777).toBe(0o600)

  // A superseded holder whose lock was replaced mid-modify must not overwrite auth.json.
  await expect(
    store.modify('openai', async () => {
      writeFileSync(lockPath, 'other-pid:foreign-token')
      return { type: 'api_key', key: 'stale-overwrite' }
    }),
  ).rejects.toThrow('ownership before committing auth update')
  expect(readFileSync(lockPath, 'utf8')).toBe('other-pid:foreign-token')
  expect(store.get('openai')).toEqual({ type: 'api_key', key: 'fresh-key' })

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
import { createJsonSchema } from '@glows777/vela'
import { silentLogger, type ExtensionAPI } from '@glows777/vela/extension-api'
export default function (api: ExtensionAPI) {
  silentLogger.debug('loaded')
  void createJsonSchema({ type: 'object' })
  api.registerTool({
    name: 'probe',
    description: 'probe',
    inputSchema: z.object({ ok: z.boolean() }),
    execute: async () => 'ok',
  })
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

test('R1 #1: home directory retains owner privileged keys and custom providers', () => {
  const root = tempDir('vela-home-coincident-')
  dirs.push(root)
  const home = root.path
  const agentDir = join(home, '.vela')
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      model: 'custom/m1',
      providers: {
        custom: {
          api: 'openai-completions',
          baseUrl: 'https://example.invalid/v1',
          models: [{ id: 'm1' }],
        },
      },
      environments: { dev: { image: 'ubuntu:24.04' } },
      location: { environment: 'dev' },
      lark: { appId: 'owner-app' },
      local: { enabled: true },
      webhooks: { port: 8787 },
      eventDefaultTarget: { channel: 'lark', chatId: 'oc_1' },
    }),
  )
  const loaded = loadConfig({ cwd: home, agentDir, trusted: true })
  expect(loaded.settings.environments).toEqual({
    dev: { image: 'ubuntu:24.04' },
  })
  expect(loaded.settings.location).toEqual({ environment: 'dev' })
  expect(loaded.settings.lark).toEqual({ appId: 'owner-app' })
  expect(loaded.settings.local).toEqual({ enabled: true })
  expect(loaded.settings.webhooks).toEqual({ port: 8787 })
  expect(loaded.settings.eventDefaultTarget).toEqual({
    channel: 'lark',
    chatId: 'oc_1',
  })
  expect(loaded.providers.custom?.models?.map((m) => m.id)).toEqual(['m1'])
})

test('R1 #2: setup writers and standalone loadModels enforce legacy preflight and strict parsing', async () => {
  const { agentDir } = setupProject()
  writeFileSync(join(agentDir, 'settings.json'), '{"model":"openai/gpt-5.5"}')
  const providers = {
    openai: {
      createModel: () => {
        throw new Error('unused')
      },
    },
  }
  await expect(saveLarkSection({ agentDir, runInApp: true })).rejects.toThrow(
    'found legacy config file(s)',
  )
  await expect(
    saveModelSetup({
      agentDir,
      ref: 'openai/gpt-5.5',
      providers,
      credential: { type: 'api_key', key: 'secret-key' },
    }),
  ).rejects.toThrow('found legacy config file(s)')
  expect(existsSync(join(agentDir, 'auth.json'))).toBe(false)
  expect(existsSync(join(agentDir, 'config.json'))).toBe(false)
  expect(() =>
    writeProviderPreset(agentDir, 'custom', { api: 'openai-completions' }),
  ).toThrow('found legacy config file(s)')
  expect(() => loadModels({ agentDir })).toThrow('found legacy config file(s)')

  const outputs: string[] = []
  const ghCode = await githubSetup({
    agentDir,
    repositories: ['glows777/Vela'],
    url: 'https://hooks.example.com',
    interactive: false,
    write: (line) => outputs.push(line),
  })
  expect(ghCode).toBe(1)
  expect(outputs.join('\n')).toContain('found legacy config file(s)')
  expect(existsSync(join(agentDir, 'config.json'))).toBe(false)

  const strictDir = setupProject({ unknownTopLevel: 1 }).agentDir
  expect(() => loadModels({ agentDir: strictDir })).toThrow(
    'unknown key "unknownTopLevel"',
  )
})

test('R1 #3: concurrent cross-process saves preserve all sections', async () => {
  const { agentDir } = setupProject()
  const settingsModule = join(import.meta.dir, '../../../src/settings.ts')
  const setupModule = join(
    import.meta.dir,
    '../../../src/providers/models/setup.ts',
  )
  for (let i = 0; i < 6; i++) {
    const dir = join(agentDir, `run-${i}`)
    mkdirSync(dir, { recursive: true })
    const p1 = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import { saveLarkSection } from ${JSON.stringify(settingsModule)}; await saveLarkSection({ agentDir: ${JSON.stringify(dir)}, runInApp: false, appId: 'app_${i}' });`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const p2 = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import { writeProviderPreset } from ${JSON.stringify(setupModule)}; writeProviderPreset(${JSON.stringify(dir)}, 'example', { api: 'openai-completions', models: [{ id: 'm' }] });`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    expect(await p1.exited).toBe(0)
    expect(await p2.exited).toBe(0)
    const saved = readRawConfigFile(dir)
    expect(saved.lark).toEqual({ appId: `app_${i}`, runInApp: false })
    expect(
      (saved.providers as Record<string, unknown> | undefined)?.example,
    ).toBeDefined()
  }
})

test('R1 #5: project MCP exposure-only override does not re-expand user variables', () => {
  const { agentDir, cwd } = setupProject(
    {
      mcpServers: {
        echo: {
          command: 'node',
          args: ['$FIRST'],
          headers: { Authorization: 'Bearer $TOKEN' },
        },
      },
    },
    {
      mcpServers: {
        echo: { enabled: true, exposure: 'direct' },
      },
    },
  )
  const loaded = loadConfig({
    cwd,
    agentDir,
    trusted: true,
    env: {
      FIRST: 'val-$SECOND',
      TOKEN: 'tok-$SECOND',
      SECOND: 'MUST_NOT_EXPAND',
    },
  })
  const echo = loaded.mcp.servers.echo as {
    args?: string[]
    headers?: Record<string, string>
    enabled?: boolean
    exposure?: string
  }
  expect(echo.args).toEqual(['val-$SECOND'])
  expect(echo.headers).toEqual({ Authorization: 'Bearer tok-$SECOND' })
  expect(echo.enabled).toBe(true)
  expect(echo.exposure).toBe('direct')
})

test('R1 #6: malformed JSON errors redact pasted secret tokens across loaders and writers', () => {
  const { agentDir, cwd } = setupProject()
  const configFile = join(agentDir, 'config.json')
  const broken = '{"providers":{"openai":{"apiKey":SECRET_LEAK_TOKEN}}}'
  writeFileSync(configFile, broken)
  for (const run of [
    () => parseConfig(broken, configFile),
    () => readRawConfigFile(agentDir),
    () => loadModels({ agentDir }),
  ]) {
    try {
      run()
      throw new Error('expected parse failure')
    } catch (error) {
      expect((error as Error).message).toContain('is not valid JSON')
      expect((error as Error).message).not.toContain('SECRET_LEAK_TOKEN')
      expect((error as Error).cause).toBeUndefined()
    }
  }
  const mcp = loadMcpServers({
    agentDir,
    projectDir: join(cwd, '.vela'),
    trusted: false,
    env: {},
  })
  expect(mcp.errors[0]).toContain('is not valid JSON')
  expect(mcp.errors[0]).not.toContain('SECRET_LEAK_TOKEN')
})

test('R1 #7: custom SDK provider marked localOnly receives undefined on channel OAuth', async () => {
  let receivedCredential: unknown = 'unset'
  const registry = new ModelRegistry(
    {
      custom: {
        oauth: {
          name: 'Local OAuth',
          localOnly: true,
          login: async () => {
            throw new Error('unused')
          },
        },
        createModel: (id, ctx) => ({
          specificationVersion: 'v4',
          provider: 'custom',
          modelId: id,
          async doGenerate() {
            receivedCredential = await ctx.credential()
            return {}
          },
          async doStream() {
            return {}
          },
        }),
      },
    },
    memoryCredentialStore({
      custom: {
        type: 'oauth',
        access: 'secret-oauth-token',
        refresh: 'r',
        expires: Date.now() + 600_000,
      },
    }),
  )
  await (
    registry.resolve('custom/m1', { channel: () => 'lark' })
      .model as unknown as {
      doGenerate(options?: unknown): Promise<unknown>
    }
  ).doGenerate({})
  expect(receivedCredential).toBeUndefined()

  await (
    registry.resolve('custom/m1').model as unknown as {
      doGenerate(options?: unknown): Promise<unknown>
    }
  ).doGenerate({})
  expect(receivedCredential).toMatchObject({
    type: 'oauth',
    access: 'secret-oauth-token',
  })
})

test('R1 #9: trusted legacy project config triggers trust and errors clearly; denied stays unread', async () => {
  const { agentDir, cwd } = setupProject()
  writeFileSync(
    join(cwd, '.vela', 'settings.json'),
    '{"model":"openai/gpt-5.5"}',
  )
  expect(projectTrustRequired(cwd, agentDir)).toBe(true)
  expect(() => loadConfig({ cwd, agentDir, trusted: false })).not.toThrow()
  expect(() => loadConfig({ cwd, agentDir, trusted: true })).toThrow(
    'found legacy config file(s)',
  )
  await expect(
    loadProjectSettings(createLocalExecutionEnv({ cwd }), {
      cwd,
      trusted: true,
      agentDir,
    }),
  ).rejects.toThrow('found legacy config file(s)')

  writeFileSync(
    join(cwd, '.vela', 'config.json'),
    JSON.stringify({ model: 'openai/gpt-5.5' }),
  )
  expect(loadConfig({ cwd, agentDir, trusted: true }).settings.model).toBe(
    'openai/gpt-5.5',
  )
})

test('R1 #12, #13, #14: strict limits/models validation, strip-before-validate on projects, and reserved namespace', async () => {
  const { agentDir, cwd } = setupProject(
    {},
    {
      location: {},
      providers: 'not-an-object',
      tools: ['+grep'],
    },
  )
  const loaded = loadConfig({ cwd, agentDir, trusted: true })
  expect(loaded.settings.tools).toEqual(['+grep'])
  const proj = await loadProjectSettings(createLocalExecutionEnv({ cwd }), {
    cwd,
    trusted: true,
    agentDir,
  })
  expect(proj.settings.tools).toEqual(['+grep'])

  const badLimits = setupProject({
    limits: { microcompact: 'false' },
  }).agentDir
  expect(() => loadConfig({ cwd, agentDir: badLimits })).toThrow(
    'Unknown key microcompact',
  )
  const badRetry = setupProject({
    limits: { maxRetries: 'typo' },
  }).agentDir
  expect(() => loadConfig({ cwd, agentDir: badRetry })).toThrow(
    'limits.maxRetries must be a non-negative finite number',
  )
  const badModelSpec = setupProject({
    providers: {
      p: { models: [{ id: 'm', contextWindow: 'typo' }] },
    },
  }).agentDir
  expect(() => loadConfig({ cwd, agentDir: badModelSpec })).toThrow(
    'providers.p.models[0].contextWindow must be a positive number',
  )

  for (const builtin of BUILTIN_NAMES) {
    expect(() =>
      parseConfig(
        JSON.stringify({ extensionConfig: { [builtin]: {} } }),
        'config.json',
      ),
    ).toThrow(`extensionConfig.${builtin} is a built-in`)
  }
  const ctor = parseConfig(
    JSON.stringify({ extensionConfig: { constructor: { custom: true } } }),
    'config.json',
  )
  expect(
    Object.getOwnPropertyDescriptor(ctor.extensionConfig, 'constructor')?.value,
  ).toEqual({ custom: true })
})

test('R2 #1: schema-invalid config blocks saveModelSetup, saveLarkSection, writeProviderPreset, and githubSetup without side effects', async () => {
  const { agentDir } = setupProject({ oldFlag: true })
  const initialConfig = readFileSync(join(agentDir, 'config.json'), 'utf8')
  const providers = {
    openai: {
      createModel: () => {
        throw new Error('unused')
      },
    },
  }
  await expect(
    saveModelSetup({
      agentDir,
      ref: 'openai/gpt-5.5',
      providers,
      credential: { type: 'api_key', key: 'secret-key' },
    }),
  ).rejects.toThrow('unknown key "oldFlag"')
  expect(existsSync(join(agentDir, 'auth.json'))).toBe(false)
  expect(readFileSync(join(agentDir, 'config.json'), 'utf8')).toBe(
    initialConfig,
  )

  await expect(saveLarkSection({ agentDir, runInApp: true })).rejects.toThrow(
    'unknown key "oldFlag"',
  )
  expect(() =>
    writeProviderPreset(agentDir, 'custom', { api: 'openai-completions' }),
  ).toThrow('unknown key "oldFlag"')

  const outputs: string[] = []
  const ghCode = await githubSetup({
    agentDir,
    repositories: ['glows777/Vela'],
    url: 'https://hooks.example.com',
    interactive: false,
    write: (line) => outputs.push(line),
  })
  expect(ghCode).toBe(1)
  expect(outputs.join('\n')).toContain('unknown key "oldFlag"')
  expect(readFileSync(join(agentDir, 'config.json'), 'utf8')).toBe(
    initialConfig,
  )
})

test('R2 #2: loadConfig.settings.mcpServers and loadConfig.mcp.servers share transport replacement and exposure override rules', () => {
  const { agentDir, cwd } = setupProject(
    {
      mcpServers: {
        docs: {
          url: 'https://owner.invalid/mcp',
          headers: { 'X-Owner': 'owner-only' },
        },
        exposed: {
          url: 'https://shared.invalid/mcp',
          headers: { Authorization: 'Bearer ok' },
          enabled: true,
        },
      },
    },
    {
      mcpServers: {
        docs: { url: 'https://project.invalid/mcp' },
        exposed: { enabled: false, exposure: 'direct' },
      },
    },
  )
  const loaded = loadConfig({ cwd, agentDir, trusted: true, env: {} })
  expect(loaded.settings.mcpServers?.docs).toEqual({
    url: 'https://project.invalid/mcp',
  })
  expect(loaded.mcp.servers.docs).toEqual({
    url: 'https://project.invalid/mcp',
  })
  expect(loaded.settings.mcpServers?.exposed).toEqual({
    url: 'https://shared.invalid/mcp',
    headers: { Authorization: 'Bearer ok' },
    enabled: false,
    exposure: 'direct',
  })
  expect(loaded.mcp.servers.exposed).toEqual({
    url: 'https://shared.invalid/mcp',
    headers: { Authorization: 'Bearer ok' },
    enabled: false,
    exposure: 'direct',
  })
})

test('R2 #3 & #4: Bun fallback preserves sibling import.meta.url assets and Node honors extension-local zod', async () => {
  const root = tempDir('vela-r2-ext-')
  dirs.push(root)
  const extDir = join(root.path, 'ext')
  mkdirSync(extDir, { recursive: true })
  writeFileSync(join(extDir, 'asset.txt'), 'ASSET_OK')
  const assetExt = join(extDir, 'with-asset.ts')
  writeFileSync(
    assetExt,
    `import { readFileSync } from 'node:fs'
import { silentLogger, type ExtensionAPI } from '@glows777/vela/extension-api'
export default function (api: ExtensionAPI) {
  silentLogger.debug('asset')
  const content = readFileSync(new URL('./asset.txt', import.meta.url), 'utf8')
  api.registerTool({ name: content, description: 'asset', execute: async () => content } as never)
}
`,
  )
  const loaded = await importExtension(assetExt, 'withAsset')
  const registered: string[] = []
  await loaded({
    registerTool(tool) {
      registered.push(tool.name)
    },
  } as Parameters<typeof loaded>[0])
  expect(registered).toEqual(['ASSET_OK'])

  const distExtensions = join(
    import.meta.dir,
    '../../../dist/driver/config/extensions.js',
  )
  if (existsSync(distExtensions)) {
    const localPkgDir = join(root.path, 'local-zod-ext')
    mkdirSync(join(localPkgDir, 'node_modules/zod'), { recursive: true })
    writeFileSync(
      join(localPkgDir, 'node_modules/zod/package.json'),
      JSON.stringify({ name: 'zod', main: 'index.cjs' }),
    )
    writeFileSync(
      join(localPkgDir, 'node_modules/zod/index.cjs'),
      'exports.z = { sentinel: () => "LOCAL_ZOD_OK" }\n',
    )
    const localExt = join(localPkgDir, 'local.ts')
    writeFileSync(
      localExt,
      `import { z } from 'zod'
import { silentLogger } from '@glows777/vela/extension-api'
export default function (api: { registerTool(t: { name: string }): void }) {
  silentLogger.debug('node')
  api.registerTool({ name: (z as unknown as { sentinel(): string }).sentinel() })
}
`,
    )
    const proc = Bun.spawn(
      [
        'node',
        '--input-type=module',
        '-e',
        `import { importExtension } from ${JSON.stringify(new URL(`file://${distExtensions}`).href)};
const fn = await importExtension(${JSON.stringify(localExt)}, 'local');
const seen = [];
await fn({ registerTool(t) { seen.push(t.name); } });
if (seen[0] !== 'LOCAL_ZOD_OK') throw new Error('Expected local zod, got ' + seen[0]);`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    expect(await proc.exited).toBe(0)
  }
})

test('R2 #7: localOnly provider checks store once per ctx.credential() call without TOCTOU OAuth leak', async () => {
  let getCalls = 0
  let currentCred:
    | { type: 'api_key'; key: string }
    | { type: 'oauth'; access: string; refresh: string; expires: number } = {
    type: 'api_key',
    key: 'api-k',
  }
  const store = {
    get: () => {
      getCalls++
      const value = currentCred
      // Flip to an OAuth token after the first read to verify no second store read occurs.
      currentCred = {
        type: 'oauth',
        access: 'leaked-oauth',
        refresh: 'r',
        expires: Date.now() + 600_000,
      }
      return value
    },
    list: () => ['custom'],
    modify: async () => undefined,
    delete: async () => {},
  }
  const seen: unknown[] = []
  const registry = new ModelRegistry(
    {
      custom: {
        oauth: {
          name: 'Local OAuth',
          localOnly: true,
          login: async () => {
            throw new Error('unused')
          },
        },
        createModel: (id, ctx) => ({
          specificationVersion: 'v4',
          provider: 'custom',
          modelId: id,
          async doGenerate() {
            seen.push(await ctx.credential())
            seen.push(await ctx.credential())
            return {}
          },
          async doStream() {
            return {}
          },
        }),
      },
    },
    store,
  )
  await (
    registry.resolve('custom/m1', { channel: () => 'lark' })
      .model as unknown as {
      doGenerate(options?: unknown): Promise<unknown>
    }
  ).doGenerate({})
  expect(getCalls).toBe(2)
  expect(seen).toEqual([{ type: 'api_key', key: 'api-k' }, undefined])
})
