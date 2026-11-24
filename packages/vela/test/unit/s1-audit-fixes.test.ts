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
import { cliProjectExtensions } from '../../src/cli/project-extensions.ts'
import { parseArgs } from '../../src/cli/setup.ts'
import {
  migrateLegacyConfigFiles,
  parseConfig,
  savedTrust,
  saveTrust,
} from '../../src/config/index.ts'
import { SessionDefaultState } from '../../src/driver/session/defaults.ts'
import { loadConfig } from '../../src/load-config.ts'
import { loadMcpServers } from '../../src/mcp/config.ts'
import {
  fileCredentialStore,
  memoryCredentialStore,
} from '../../src/providers/auth/store.ts'
import { ModelRegistry } from '../../src/providers/models/index.ts'
import { loadModels } from '../../src/providers/models-config.ts'
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

  // Trust canonicalizes symlinked dir, keeps denial over inherited parent grant (#3), and preserves existing dir mode (#10)
  const parentTrusted = join(dir, 'trusted-parent')
  const deniedReal = join(parentTrusted, 'sub')
  const deniedLink = join(dir, 'link-proj')
  mkdirSync(deniedReal, { recursive: true })
  const sharedAgentDir = join(dir, 'shared-agent')
  mkdirSync(sharedAgentDir, { recursive: true, mode: 0o755 })
  const origMode = lstatSync(sharedAgentDir).mode & 0o777
  saveTrust(sharedAgentDir, parentTrusted, true)
  expect(lstatSync(sharedAgentDir).mode & 0o777).toBe(origMode)
  symlinkSync(deniedReal, deniedLink)
  saveTrust(sharedAgentDir, deniedLink, false)
  const trustPath = join(sharedAgentDir, 'trust.json')
  expect(lstatSync(trustPath).mode & 0o777).toBe(0o600)
  expect(savedTrust(sharedAgentDir, deniedLink)).toBe(false)
  expect(savedTrust(sharedAgentDir, deniedReal)).toBe(false)

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

  // MCP config skips disabled servers with missing env, re-interpolates on trusted enable (#7), and skips spurious error
  const envRef = (name: string) => `$${'{'}${name}}`
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      mcpServers: {
        disabledMissing: {
          enabled: false,
          command: envRef('ENABLED_CMD'),
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
        disabledMissing: { enabled: true },
      },
    }),
  )
  const mcp = loadMcpServers({
    agentDir,
    projectDir: join(projDir, '.vela'),
    trusted: true,
    env: {},
  })
  expect(mcp.servers.disabledMissing).toBeUndefined()
  expect(mcp.errors.some((e) => e.includes('MISSING_VAR'))).toBe(true)
  expect(mcp.errors.some((e) => e.includes('MISSING_CMD'))).toBe(true)
  const mcpResolved = loadMcpServers({
    agentDir,
    projectDir: join(projDir, '.vela'),
    trusted: true,
    env: { ENABLED_CMD: 'resolved-bin', MISSING_VAR: 'val' },
  })
  expect(mcpResolved.servers.disabledMissing).toMatchObject({
    enabled: true,
    command: 'resolved-bin',
  })
})

test('auth localOnly channel blocks local & lark (#4), $$ secret literal, live planLabel, atomic logout race (#6), and store cache', async () => {
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

  // Undefined channel sees localOnly credential & planLabel; any channel ('local' or 'lark') blocks it (#4)
  expect(reg.planLabel('sub', undefined)).toBe('Pro plan')
  expect(reg.planLabel('sub', 'local')).toBeUndefined()
  expect(reg.planLabel('sub', 'lark')).toBeUndefined()
  const resolved = reg.resolve('sub/s1')
  const state = new SessionDefaultState(
    { model: undefined, thinkingLevel: 'off', limitOverrides: {} },
    {},
  )
  expect(
    state.info(
      resolved,
      { planLabel: (p, ch) => reg.planLabel(p, ch) },
      undefined,
    ).planLabel,
  ).toBe('Pro plan')
  expect(
    state.info(
      resolved,
      { planLabel: (p, ch) => reg.planLabel(p, ch) },
      'local',
    ).planLabel,
  ).toBeUndefined()

  // Atomic logout race: queued modify() before revoke completes must not be deleted (#6)
  const memStore = memoryCredentialStore({
    sub: { type: 'oauth', access: 'old', refresh: 'r', expires: 99_999 },
  })
  const origDeleteIf = memStore.deleteIf!
  let raceStarted!: () => void
  let raceDone = false
  const raceReg = new ModelRegistry(
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
            access: 'x',
            refresh: 'r',
            expires: 9,
          }),
          refresh: async (c) => c,
          logout: async () => {
            raceStarted()
          },
        },
      },
    },
    {
      ...memStore,
      deleteIf: async (p, pred) => {
        if (!raceDone) {
          raceDone = true
          await memStore.modify('sub', async () => ({
            type: 'oauth',
            access: 'concurrent-new',
            refresh: 'r',
            expires: 99_999,
          }))
        }
        return origDeleteIf(p, pred)
      },
    },
  )
  const rs = new Promise<void>((r) => {
    raceStarted = r
  })
  const raceRes = raceReg.logout('sub')
  await rs
  expect(await raceRes).toBe(false)
  expect(memStore.get('sub')).toMatchObject({ access: 'concurrent-new' })

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
