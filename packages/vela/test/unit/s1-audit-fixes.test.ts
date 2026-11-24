import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z as z3 } from 'zod/v3'
import { cliProjectExtensions } from '../../src/cli/project-extensions.ts'
import { parseArgs } from '../../src/cli/setup.ts'
import {
  migrateLegacyConfigFiles,
  parseConfig,
  savedTrust,
  saveTrust,
} from '../../src/config/index.ts'
import { messageEnvelopeChars } from '../../src/driver/messages.ts'
import { SessionDefaultState } from '../../src/driver/session/defaults.ts'
import {
  buildSessionContext,
  messageText,
  type SessionEntry,
} from '../../src/driver/session/entries.ts'
import { renderSessionHtml } from '../../src/driver/session/export-html.ts'
import { SessionStore } from '../../src/driver/session/index.ts'
import { fileSessionStorage } from '../../src/driver/session/storage.ts'
import { loadConfig } from '../../src/load-config.ts'
import { loadMcpServers } from '../../src/mcp/config.ts'
import { fileCredentialStore } from '../../src/providers/auth/store.ts'
import {
  fromAiResponseMessage,
  fromAiToolOutput,
  toAiModelMessages,
  toAiToolOutput,
} from '../../src/providers/messages.ts'
import {
  isRemoteChannel,
  ModelRegistry,
} from '../../src/providers/models/index.ts'
import { loadModels } from '../../src/providers/models-config.ts'
import { resolveProviderTools } from '../../src/providers/runtime.ts'
import {
  normalizeVelaContent,
  normalizeVelaMessage,
} from '../../src/shared/messages.ts'
import { createJsonSchema } from '../../src/shared/tool-schema.ts'
import { createMockModel } from '../../src/testing/core/demo-model.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

test('providers/messages preserves providerOptions, normalizes binary tool output, handles IMAGE_MEDIA_TYPE and assistant tool_result', () => {
  const wireUser = toAiModelMessages([
    {
      role: 'user',
      content: [
        {
          type: 'image',
          data: 'aGVsbG8=',
          mimeType: 'IMAGE/PNG',
          providerOptions: {
            anthropic: { cacheControl: { type: 'ephemeral' } },
          },
        },
      ],
    },
  ])
  expect(
    (wireUser[0]!.content[0] as Record<string, unknown>).providerOptions,
  ).toEqual({
    anthropic: { cacheControl: { type: 'ephemeral' } },
  })

  const rawBytes = new Uint8Array([1, 2, 3, 4])
  const buf = rawBytes.buffer
  const fromOut = fromAiToolOutput({
    type: 'content',
    value: [
      {
        type: 'text',
        text: 'ok',
        providerOptions: { openai: { p: 1 } },
      } as never,
      { type: 'image-data', data: rawBytes as never, mediaType: 'image/png' },
      {
        type: 'media',
        data: Buffer.from(buf).toString('base64'),
        mediaType: 'image/webp',
      } as never,
      {
        type: 'file-data',
        data: buf as never,
        mediaType: 'image/jpeg',
        providerOptions: { openai: { tag: 'img' } },
      } as never,
    ],
  })
  expect(fromOut.type).toBe('content')
  if (fromOut.type === 'content') {
    expect(fromOut.value[0]).toEqual({
      type: 'text',
      text: 'ok',
      providerOptions: { openai: { p: 1 } },
    })
    expect((fromOut.value[1] as { data: string }).data).toBe('AQIDBA==')
    expect(
      (fromOut.value[2] as { type: string; mimeType?: string }).mimeType,
    ).toBe('image/webp')
    expect(
      (fromOut.value[3] as { providerOptions?: unknown }).providerOptions,
    ).toEqual({
      openai: { tag: 'img' },
    })
  }

  const aiOut = toAiToolOutput({
    type: 'content',
    value: [
      {
        type: 'image',
        data: 'AQID',
        mimeType: 'image/png',
        providerOptions: { test: { keep: true } },
      },
    ],
  })
  expect(
    (aiOut as { value: Record<string, unknown>[] }).value[0]!.providerOptions,
  ).toEqual({
    test: { keep: true },
  })

  // Assistant error tool-result & supportsImages=false omission
  const adapted = toAiModelMessages(
    [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'c1',
            toolName: 'search',
            output: {
              type: 'content',
              isError: true,
              value: [{ type: 'image', data: 'AQID', mimeType: 'image/png' }],
            } as never,
          },
        ],
      },
    ],
    false,
  )
  const assistantPart = adapted[0]!.content[0] as Record<string, unknown>
  expect(assistantPart.type).toBe('tool-result')
  expect((assistantPart.output as { type: string }).type).toBe('error-text')

  // Assistant edge normalization + tool-approval-request metadata round-trip
  const normalizedEdge = toAiModelMessages([
    normalizeVelaMessage({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'think' },
        {
          type: 'tool-approval-request',
          approvalId: 'ap1',
          toolCallId: 'tc1',
          reason: 'needs ok',
          isAutomatic: false,
          signature: 'sig-1',
          inputSchemaInput: { x: 1 },
        },
      ],
    }),
  ])
  expect((normalizedEdge[0]!.content[0] as { type: string }).type).toBe(
    'reasoning',
  )
  expect(normalizedEdge[0]!.content[1]).toMatchObject({
    type: 'tool-approval-request',
    approvalId: 'ap1',
    toolCallId: 'tc1',
    reason: 'needs ok',
    isAutomatic: false,
    signature: 'sig-1',
    inputSchemaInput: { x: 1 },
  })

  const parsedResp = fromAiResponseMessage({
    role: 'assistant',
    content: [
      {
        type: 'tool-approval-request',
        approvalId: 'ap2',
        toolCallId: 'tc2',
        reason: 'check',
        isAutomatic: true,
      } as never,
    ],
  })
  expect(parsedResp.content[0]).toMatchObject({
    type: 'tool-approval-request',
    reason: 'check',
    isAutomatic: true,
  })
})

test('shared/driver messages normalize nested tool images and Buffer payloads, strict messageText, export-html, loadSaved', async () => {
  const res = normalizeVelaContent([
    {
      type: 'tool-result',
      toolCallId: 'tc',
      toolName: 't',
      output: {
        type: 'content',
        value: [
          {
            type: 'image-data',
            data: { type: 'Buffer', data: [1, 2, 3] },
            mediaType: 'image/png',
          },
          { type: 'media', data: 'AQID', mediaType: 'image/gif' },
          {
            type: 'file',
            mediaType: 'image/jpeg',
            data: { type: 'data', data: 'AQID' },
          },
        ],
      },
    },
  ])
  expect(res.changed).toBe(true)
  const tr = res.content[0] as { output: { value: Record<string, unknown>[] } }
  expect(tr.output.value[0]).toMatchObject({
    type: 'image',
    data: 'AQID',
    mimeType: 'image/png',
  })
  expect(tr.output.value[1]).toMatchObject({
    type: 'image',
    data: 'AQID',
    mimeType: 'image/gif',
  })
  expect(tr.output.value[2]).toMatchObject({
    type: 'image',
    data: 'AQID',
    mimeType: 'image/jpeg',
  })

  // messageText strictly ignores thinking / non-text parts carrying .text
  expect(
    messageText([
      { type: 'thinking', text: 'secret-thought' },
      { type: 'text', text: 'visible' },
    ]),
  ).toBe('visible')

  // messageEnvelopeChars recognizes legacy media image parts
  expect(
    messageEnvelopeChars([
      {
        role: 'user',
        content: [
          {
            type: 'media',
            data: 'x'.repeat(20_000),
            mediaType: 'image/png',
          } as never,
        ],
      },
    ]),
  ).toBeLessThan(6000)

  // FileSessionStore.loadSaved, buildSessionContext, and renderSessionHtml normalize legacy custom_message arrays
  const dir = tempDir('vela-s1-sess-')
  const storage = fileSessionStorage(dir)
  const file = join(dir, 'legacy-cm.jsonl')
  const header = {
    type: 'session',
    version: 2,
    id: 'legacy-cm',
    timestamp: '2026-11-24T00:00:00.000Z',
  }
  const entry = {
    type: 'custom_message',
    id: 'e1',
    parentId: null,
    timestamp: '2026-11-24T00:00:01.000Z',
    customType: 'note',
    display: true,
    content: [{ type: 'reasoning', text: 'legacy-r' }],
  }
  writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`)
  const store = new SessionStore('legacy-cm', dir, undefined, storage)
  const saved = await store.loadSaved()
  expect(saved).toBeDefined()
  expect(
    (saved!.messages[0] as { content: { type: string }[] }).content[0]!.type,
  ).toBe('thinking')
  const ctx = buildSessionContext([entry as never])
  expect(
    (ctx.messages[0] as { content: { type: string }[] }).content[0]!.type,
  ).toBe('thinking')
  const html = renderSessionHtml({
    id: 'legacy-cm',
    entries: [
      {
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-11-24T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'legacy-thought' },
            { type: 'text', text: 'legacy-visible' },
          ],
        } as never,
      },
      {
        ...entry,
        content: [{ type: 'text', text: 'cm-text' }],
      } as unknown as SessionEntry,
    ],
  })
  expect(html).toContain('legacy-thought')
  expect(html).toContain('legacy-visible')
  expect(html).toContain('cm-text')
})

test('createJsonSchema detects schema drafts and resolveProviderTools extracts Zod v3 schemas', async () => {
  const draft7 = createJsonSchema({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { n: { type: 'number', exclusiveMinimum: 0 } },
    required: ['n'],
  })
  expect(await draft7.validate!({ n: 1 })).toEqual({
    success: true,
    value: { n: 1 },
  })
  expect((await draft7.validate!({ n: 0 })).success).toBe(false)

  const zodV3Schema = z3.object({ query: z3.string().min(1) })
  const resolved = await resolveProviderTools(createMockModel(), [
    {
      name: 'v3_tool',
      description: 'zod v3 test',
      inputSchema: zodV3Schema as never,
      execute: async (input) => input,
    },
  ])
  expect(resolved.toolDefinitions).toHaveLength(1)
  expect(
    (resolved.toolDefinitions[0] as { inputSchema: Record<string, unknown> })
      .inputSchema,
  ).toMatchObject({
    type: 'object',
    properties: { query: { type: 'string' } },
  })
})

test('config schema, legacy migration, trust, cliProjectExtensions (-builtin:rag), and mcp loading', async () => {
  expect(() =>
    parseConfig(
      JSON.stringify({ providers: { 'bad provider!': {} } }),
      'test.json',
    ),
  ).toThrow(/Invalid provider name/i)
  expect(() =>
    parseConfig(
      JSON.stringify({ skills: ['builtin:rag'] }),
      'test.json',
      (p) => {
        throw new Error(`unexpected resolvePath(${p})`)
      },
    ),
  ).toThrow(/unexpected resolvePath/)

  const dir = tempDir('vela-s1-cfg-')
  const agentDir = join(dir, 'agent')
  const projDir = join(dir, 'proj')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(join(projDir, '.vela'), { recursive: true })
  writeFileSync(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      $schema: 'https://example.com/schema.json',
      extensions: ['+builtin:memory', '-builtin:rag', 'builtin:rag'],
    }),
  )
  const mig = migrateLegacyConfigFiles(agentDir)
  expect(mig.migrated).toBe(true)
  expect(mig.warnings.join('\n')).toMatch(/builtin:rag/)
  const written = JSON.parse(
    readFileSync(join(agentDir, 'config.json'), 'utf8'),
  )
  expect(written.$schema).toBeUndefined()
  expect(written.extensions).toEqual(['+builtin:memory'])

  // Trust canonicalizes symlinked dir and writes 0600 non-symlink trust.json
  const realProj = join(dir, 'real-proj')
  const linkProj = join(dir, 'link-proj')
  mkdirSync(realProj, { recursive: true })
  symlinkSync(realProj, linkProj)
  saveTrust(agentDir, linkProj, true)
  const trustPath = join(agentDir, 'trust.json')
  expect(lstatSync(trustPath).mode & 0o777).toBe(0o600)
  expect(savedTrust(agentDir, realProj)).toBe(true)

  // cliProjectExtensions allows -builtin:rag without warning or error
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({ extensions: ['-builtin:rag'] }),
  )
  const config = loadConfig({
    cwd: projDir,
    agentDir,
    trusted: true,
    builtins: ['mcp', 'memory'],
    env: {},
  })
  const diags: string[] = []
  const loader = cliProjectExtensions(config, parseArgs([]), (m) =>
    diags.push(m),
  )
  await loader({
    cwd: projDir,
    environmentId: 'node:local',
    trusted: true,
    settings: {},
    projectSettings: {},
    entries: [],
  })
  expect(diags).toEqual([])

  // MCP config skips disabled servers with missing env & does not spurious-error on failed user server override
  const envRef = (name: string) => `$${'{'}${name}}`
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      mcpServers: {
        disabledMissing: {
          enabled: false,
          command: 'cmd',
          env: { K: envRef('MISSING_VAR') },
        },
        brokenUser: { command: envRef('MISSING_CMD') },
      },
    }),
  )
  writeFileSync(
    join(projDir, '.vela', 'config.json'),
    JSON.stringify({
      mcpServers: {
        brokenUser: { enabled: false },
      },
    }),
  )
  const mcp = loadMcpServers({
    agentDir,
    projectDir: join(projDir, '.vela'),
    trusted: true,
    env: {},
  })
  expect(mcp.servers.disabledMissing).toMatchObject({ enabled: false })
  expect(mcp.errors.length).toBe(1)
  expect(mcp.errors[0]).toContain('MISSING_CMD')
})

test('auth localOnly/local channel, $$ secret literal, live planLabel, logout guard, and fileCredentialStore ino invalidation', async () => {
  expect(isRemoteChannel(undefined)).toBe(false)
  expect(isRemoteChannel('local')).toBe(false)
  expect(isRemoteChannel('lark')).toBe(true)

  const dir = tempDir('vela-s1-auth-')
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      providers: {
        myprov: {
          api: 'openai-completions',
          baseUrl: 'https://example.invalid/v1',
          apiKey: '$$RAW_SECRET_TOKEN',
          models: [
            { id: 'm1', name: 'M1', contextWindow: 8192, maxTokens: 1024 },
          ],
        },
      },
    }),
  )
  const defs = loadModels({ agentDir: dir, env: {} })
  expect(defs.myprov!.authSource!(undefined)).not.toContain('RAW_SECRET_TOKEN')

  const authFile = join(dir, 'auth.json')
  const store = fileCredentialStore(authFile)
  await store.modify('sub', async () => ({
    type: 'oauth',
    access: 'tok-1',
    refresh: 'ref-1',
    expires: Date.now() + 60_000,
  }))
  let revokeResolve!: () => void
  let revokeStarted!: () => void
  const reg = new ModelRegistry(
    {
      sub: {
        createModel: () => createMockModel(),
        models: [
          { id: 's1', name: 'S1', contextWindow: 8192, maxTokens: 1024 },
        ],
        oauth: {
          name: 'Sub',
          localOnly: true,
          isSubscription: true,
          planLabel: 'Pro plan',
          login: async () => ({
            type: 'oauth',
            access: 'tok-2',
            refresh: 'ref-2',
            expires: Date.now() + 60_000,
          }),
          refresh: async (c) => c,
          logout: () =>
            new Promise<void>((res) => {
              revokeStarted()
              revokeResolve = res
            }),
        },
      },
    },
    store,
  )

  // local channel sees localOnly credential & planLabel; lark hides it
  expect(reg.planLabel('sub', 'local')).toBe('Pro plan')
  expect(reg.planLabel('sub', 'lark')).toBeUndefined()
  const resolved = reg.resolve('sub/s1', { channel: () => 'local' })
  const state = new SessionDefaultState(
    { model: undefined, thinkingLevel: 'off', limitOverrides: {} },
    {},
  )
  expect(
    state.info(
      resolved,
      { planLabel: (p, ch) => reg.planLabel(p, ch) },
      'local',
    ).planLabel,
  ).toBe('Pro plan')
  expect(
    state.info(resolved, { planLabel: (p, ch) => reg.planLabel(p, ch) }, 'lark')
      .planLabel,
  ).toBeUndefined()

  // Concurrent replacement during logout must not delete the new credential
  const startedP = new Promise<void>((r) => {
    revokeStarted = r
  })
  const logoutP = reg.logout('sub')
  await startedP
  await store.modify('sub', async () => ({
    type: 'oauth',
    access: 'tok-new',
    refresh: 'ref-new',
    expires: Date.now() + 60_000,
  }))
  revokeResolve()
  expect(await logoutP).toBe(false)
  expect(store.get('sub')).toMatchObject({ access: 'tok-new' })

  // Aborting logout during revoke rejects and leaves the stored credential intact
  let rejectStarted!: () => void
  const abortReg = new ModelRegistry(
    {
      sub: {
        createModel: () => createMockModel(),
        models: [
          { id: 's1', name: 'S1', contextWindow: 8192, maxTokens: 1024 },
        ],
        oauth: {
          name: 'Sub',
          login: async () => ({
            type: 'oauth',
            access: 'tok-x',
            refresh: 'ref-x',
            expires: Date.now() + 60_000,
          }),
          refresh: async (c) => c,
          logout: (_cred, signal) =>
            new Promise<void>((_res, rej) => {
              rejectStarted()
              signal.addEventListener('abort', () => rej(signal.reason), {
                once: true,
              })
            }),
        },
      },
    },
    store,
  )
  const ac = new AbortController()
  const abortedStart = new Promise<void>((r) => {
    rejectStarted = r
  })
  const abortedLogout = abortReg.logout('sub', { signal: ac.signal })
  await abortedStart
  ac.abort(new DOMException('Cancelled', 'AbortError'))
  await expect(abortedLogout).rejects.toThrow(/Cancelled|abort/i)
  expect(store.get('sub')).toMatchObject({ access: 'tok-new' })

  // Removing auth.json clears store cache
  rmSync(authFile)
  expect(store.get('sub')).toBeUndefined()
})

test('Node.js jiti host shim preserves instanceof ToolExecutionResult and defineJsonSchemaTool', async () => {
  const dir = tempDir('vela-s1-jiti-')
  const pkgDir = join(dir, 'pkg')
  const buildDir = join(pkgDir, 'node-build')
  const extPath = join(dir, 'node-ext.ts')
  const velaRoot = resolve(import.meta.dir, '../..')
  mkdirSync(pkgDir, { recursive: true })
  symlinkSync(
    resolve(velaRoot, '../../node_modules'),
    join(dir, 'node_modules'),
  )
  symlinkSync(join(velaRoot, 'node_modules'), join(pkgDir, 'node_modules'))
  const extensionsMod = join(velaRoot, 'src/driver/config/extensions.ts')
  const extApiMod = join(velaRoot, 'src/extension-api.ts')
  const built = await Bun.build({
    entrypoints: [extensionsMod, extApiMod],
    outdir: buildDir,
    root: join(velaRoot, 'src'),
    target: 'node',
    format: 'esm',
    external: ['zod', 'jiti', 'node:*', '@glows777/*'],
  })
  expect(built.success).toBe(true)
  const builtExtensions = join(buildDir, 'driver/config/extensions.js')
  const builtExtApi = join(buildDir, 'extension-api.js')
  writeFileSync(
    extPath,
    `import { createJsonSchema, defineJsonSchemaTool, ToolExecutionResult } from '@glows777/vela/extension-api'
export default function (vela) {
  vela.registerTool(
    defineJsonSchemaTool({
      name: 'echo_jiti',
      description: 'test tool',
      inputSchema: createJsonSchema({ type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] }),
      async execute() { return new ToolExecutionResult({ ok: true }, [{ type: 'text', text: 'ok' }]) },
    }),
  )
}
`,
  )
  const script = `
import { registerExtensionHostModules, importExtension } from ${JSON.stringify(builtExtensions)}
import * as extApi from ${JSON.stringify(builtExtApi)}
registerExtensionHostModules({ '@glows777/vela/extension-api': async () => extApi })
const ext = await importExtension(${JSON.stringify(extPath)}, 'node-ext')
const tools = []
await ext({ registerTool(t) { tools.push(t) } })
const tool = tools[0]
const res = await tool.execute({ msg: 'hi' }, {})
console.log(JSON.stringify({ isInstance: res instanceof extApi.ToolExecutionResult, name: tool.name }))
`
  const proc = spawnSync('node', ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  })
  expect(proc.status, proc.stderr).toBe(0)
  expect(JSON.parse(proc.stdout.trim())).toEqual({
    isInstance: true,
    name: 'echo_jiti',
  })
  expect(existsSync(extPath)).toBe(true)
})
