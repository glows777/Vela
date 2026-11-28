/**
 * Consumer smoke test: use `@glows777/vela` the way an external project would.
 * Builds and packs the single published package, serving its tarball from a disposable local registry.
 * Installs into fresh, empty Node and Bun projects outside the workspace:
 * - Node project (npm install): strict NodeNext tsconfig (exactOptionalPropertyTypes etc.,
 *   no @types/bun) type-checks `@glows777/vela`, `@glows777/vela/extension-api`, and `@glows777/vela/testing`,
 *   then runs Runtime SDK, daemon IPC, MCP, image, extension-api, Lark fake transport, and CLI smoke under Node;
 * - Bun project (bun install): default `bun init` tsconfig, runs the same SDK smoke and CLI under Bun.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { $ } from 'bun'
import { packWorkspaces } from './workspaces.ts'

const ROOT = resolve(import.meta.dir, '..')
const tooling = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const work = await mkdtemp(join(tmpdir(), 'vela-consumer-'))

const IMAGE = (
  await readFile(join(ROOT, 'test/fixtures/images/wide.png'))
).toString('base64')

const SMOKE = `
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  connectRuntime,
  createLarkChannelAdapter,
  createLocalExecutionEnv,
  createRuntime,
  DaemonAlreadyRunningError,
  EnvironmentRegistry,
  fileCredentialStore,
  getDaemonStatus,
  LarkChannelAdapter,
  larkConfig,
  loadConfig,
  loadModels,
  memoryCredentialStore,
  RuntimeWebhookReceiver,
  silentLogger,
  startDaemon,
  startDaemonServer,
  stopDaemon,
  type AgentDriverCapabilities,
  type ConnectRuntimeOptions,
  type CreateRuntimeOptions,
  type DaemonStatus,
  type ImageContent,
  type LarkChannelAdapterOptions,
  type LarkMessageEvent,
  type LarkTransport,
  type LocalVelaRuntime,
  type RuntimeEvent,
  type SessionKind,
  type SessionState,
  type VelaRuntime,
} from '@glows777/vela'
import * as rootNamespace from '@glows777/vela'
import {
  createJsonSchema,
  defineJsonSchemaTool,
  SpilledToolOutput,
  ToolExecutionResult,
  type ExtensionAPI,
  type ToolContent,
  type VelaExtension,
} from '@glows777/vela/extension-api'
import {
  cleanupTestVelas,
  createFauxModel,
  createTestVela,
  fauxText,
  fauxToolCall,
} from '@glows777/vela/testing'
import { z } from 'zod'

// Verify root package converges to the 18 Runtime/Daemon symbols (no legacy/retired exports).
const rootExports = Object.entries(rootNamespace as Record<string, unknown>)
  .filter(([, value]) => value !== undefined)
  .map(([key]) => key)
  .sort()
const expectedRootExports = [
  'DaemonAlreadyRunningError',
  'EnvironmentRegistry',
  'LarkChannelAdapter',
  'RuntimeWebhookReceiver',
  'connectRuntime',
  'createLarkChannelAdapter',
  'createLocalExecutionEnv',
  'createRuntime',
  'fileCredentialStore',
  'getDaemonStatus',
  'larkConfig',
  'loadConfig',
  'loadModels',
  'memoryCredentialStore',
  'silentLogger',
  'startDaemon',
  'startDaemonServer',
  'stopDaemon',
].sort()
assert.deepEqual(rootExports, expectedRootExports)
for (const retired of [
  'createVela',
  'VelaSession',
  'web',
  'webConfig',
  'mcp',
  'mcpConfig',
  'memory',
  'todo',
  'background',
  'createJsonSchema',
  'defineJsonSchemaTool',
  'ToolExecutionResult',
  'SpilledToolOutput',
  'inspectSession',
  'inspectVela',
  'saveLarkSection',
  'saveModelSetup',
  'usableModel',
  'importExtension',
]) {
  assert.equal(retired in rootNamespace, false, \`retired export leaked: \${retired}\`)
}
if (typeof defineJsonSchemaTool !== 'function' || typeof createJsonSchema !== 'function')
  throw new Error('missing @glows777/vela/extension-api export')
if (typeof SpilledToolOutput !== 'function')
  throw new Error('missing SpilledToolOutput export')
if (typeof createLarkChannelAdapter !== 'function')
  throw new Error('missing createLarkChannelAdapter export')
if (typeof connectRuntime !== 'function' || typeof startDaemonServer !== 'function')
  throw new Error('missing daemon runtime exports')
const _smokeChecks = (
  _c?: ConnectRuntimeOptions,
  _s?: DaemonStatus,
  _cap?: AgentDriverCapabilities,
  _kind?: SessionKind,
  _state?: SessionState,
  _env?: EnvironmentRegistry,
  _cls?: typeof LarkChannelAdapter,
  _err?: typeof DaemonAlreadyRunningError,
  _recv?: typeof RuntimeWebhookReceiver,
  _cfg?: typeof larkConfig,
  _lc?: typeof loadConfig,
  _lm?: typeof loadModels,
  _fc?: typeof fileCredentialStore,
  _mc?: typeof memoryCredentialStore,
  _le?: typeof createLocalExecutionEnv,
  _sl?: typeof silentLogger,
  _gs?: typeof getDaemonStatus,
  _sd?: typeof startDaemon,
  _st?: typeof stopDaemon,
  _rt?: VelaRuntime,
) => void [
  _c, _s, _cap, _kind, _state, _env, _cls, _err, _recv, _cfg, _lc, _lm, _fc,
  _mc, _le, _sl, _gs, _sd, _st, _rt,
]
void _smokeChecks

const hello: VelaExtension = (api) => {
  api.registerTool({
    name: 'greet',
    description: 'greet someone',
    inputSchema: z.object({ name: z.string() }),
    annotations: { readOnlyHint: true },
    execute: async ({ name }: { name: string }) => \`hi \${name}\`,
  })
}

const helloModel = createFauxModel({
  responses: [fauxToolCall('hello_greet', { name: 'Vela' }), fauxText('done')],
})
const helloRuntime: LocalVelaRuntime = createRuntime({
  ephemeral: true,
  defaultModel: helloModel,
  extensions: [hello],
  mcp: false,
})
const helloEvents: string[] = []
try {
  await helloRuntime.ready()
  const s0 = await helloRuntime.sessions.create({ name: 'default' })
  const off = helloRuntime.events.subscribe((e: RuntimeEvent) => {
    helloEvents.push(e.type)
  })
  await helloRuntime.prompt(s0.id, { text: 'say hi' })
  await helloRuntime.waitForIdle(s0.id)
  off()
  const typeChecks = () => {
    // @ts-expect-error prompt input requires an object with text
    void helloRuntime.prompt(s0.id, 42)
    // @ts-expect-error legacy sessions(opts) permissions field was removed
    void helloRuntime.sessions.configure(s0.id, { permissions: { bash: 'ask' } })
  }
  void typeChecks
  // @ts-expect-error no such RuntimeEvent type
  const bogus: RuntimeEvent = { type: 'no_such_event' }
  void bogus
} finally {
  await helloRuntime.dispose()
}
if (!helloEvents.includes('tool_finished') || !helloEvents.includes('run_finished'))
  throw new Error(\`unexpected runtime events: \${helloEvents.join(',')}\`)
if (!JSON.stringify(helloModel.calls[1]?.prompt).includes('hi Vela'))
  throw new Error('inline extension tool result did not reach the model')

const t = createTestVela({ responses: [fauxText('ok')] })
await t.run('hello')
if (t.lastAssistantText() !== 'ok') throw new Error('createTestVela failed')

// Standalone .ts extension outside node_modules resolves host zod + @glows777/vela/extension-api via jiti / Bun.build
const extRoot = await mkdtemp(join(tmpdir(), 'vela-ext-smoke-'))
try {
  const extPath = join(extRoot, 'standalone.ts')
  await writeFile(
    extPath,
    [
      "import { z } from 'zod'",
      "import type { ExtensionAPI } from '@glows777/vela/extension-api'",
      'export default function (api: ExtensionAPI) {',
      "  api.registerTool({ name: 'ping', description: 'ping', inputSchema: z.object({ v: z.string() }), execute: async ({ v }: { v: string }) => 'pong:' + v })",
      '}',
    ].join('\\n'),
  )
  const extModel = createFauxModel({
    responses: [fauxToolCall('standalone_ping', { v: 'jiti' }), fauxText('ext ok')],
  })
  const extRuntime = createRuntime({
    ephemeral: true,
    defaultModel: extModel,
    extensions: [extPath],
    mcp: false,
  })
  try {
    await extRuntime.ready()
    const extSession = await extRuntime.sessions.create({ name: 'ext' })
    await extRuntime.prompt(extSession.id, { text: 'ping jiti' })
    await extRuntime.waitForIdle(extSession.id)
    if (!JSON.stringify(extModel.calls[1]?.prompt).includes('pong:jiti'))
      throw new Error('standalone extension tool did not execute')
  } finally {
    await extRuntime.dispose()
  }
} finally {
  rmSync(extRoot, { recursive: true, force: true })
}
void mkdirSync

// Default createRuntime() resolves packaged docs into <docs>; docs: false omits them.
const docsSystems: string[] = []
const docsModel = createFauxModel({
  responses: [
    (req) => {
      docsSystems.push(req.system ?? '')
      return fauxText('docs on')
    },
    (req) => {
      docsSystems.push(req.system ?? '')
      return fauxText('docs off')
    },
  ],
})
const docsOnRuntime = createRuntime({
  ephemeral: true,
  defaultModel: docsModel,
  mcp: false,
})
const docsOffRuntime = createRuntime({
  ephemeral: true,
  defaultModel: docsModel,
  mcp: false,
  docs: false,
})
try {
  await docsOnRuntime.ready()
  await docsOffRuntime.ready()
  const ds1 = await docsOnRuntime.sessions.create({ name: 'docs-on' })
  await docsOnRuntime.prompt(ds1.id, { text: 'check docs' })
  await docsOnRuntime.waitForIdle(ds1.id)
  const ds2 = await docsOffRuntime.sessions.create({ name: 'docs-off' })
  await docsOffRuntime.prompt(ds2.id, { text: 'check no docs' })
  await docsOffRuntime.waitForIdle(ds2.id)
  const docsMatch = /- Additional docs: ([^\\n]+)/.exec(docsSystems[0] ?? '')
  const resolvedDocsDir = docsMatch?.[1]?.trim()
  if (
    !docsSystems[0]?.includes('<docs>') ||
    !resolvedDocsDir ||
    !existsSync(join(resolvedDocsDir, 'sdk.md'))
  )
    throw new Error(
      \`packaged createRuntime() did not render readable <docs> section: \${docsSystems[0] ?? ''}\`,
    )
  if (docsSystems[1]?.includes('<docs>'))
    throw new Error('docs: false failed to suppress <docs> section')
} finally {
  await docsOnRuntime.dispose()
  await docsOffRuntime.dispose()
}

// Photon WASM must resolve from the installed package under both Node and Bun.
const image: ImageContent = { type: 'image', data: '${IMAGE}', mimeType: 'image/png' }
const imgModel = createFauxModel({ responses: [fauxText('image received')] })
const imgRuntime = createRuntime({
  ephemeral: true,
  defaultModel: imgModel,
  mcp: false,
})
try {
  await imgRuntime.ready()
  const imgSession = await imgRuntime.sessions.create({ name: 'images' })
  const blob = await imgRuntime.blobs.storeInbound({
    sessionId: imgSession.id,
    filename: 'wide.png',
    mimeType: 'image/png',
    bytes: new Uint8Array(Buffer.from(image.data, 'base64')),
  })
  await imgRuntime.prompt(imgSession.id, {
    text: 'Describe the image',
    attachments: [{ blobId: blob.id, name: 'wide.png', mimeType: 'image/png', inlineOnly: true }],
  })
  await imgRuntime.waitForIdle(imgSession.id)
  const providerUserFiles =
    imgModel.calls[0]?.prompt.flatMap((m) =>
      m.role === 'user' && Array.isArray(m.content)
        ? m.content.filter((p) => p.type === 'file' && p.mediaType.startsWith('image/'))
        : [],
    ) ?? []
  const imgPage = await imgRuntime.sessions.messages({ sessionId: imgSession.id })
  const storedUser = imgPage.messages.find((m) => m.role === 'user')
  if (
    providerUserFiles.length !== 1 ||
    !storedUser ||
    JSON.stringify(imgModel.calls[0]?.prompt).includes(image.data) ||
    JSON.stringify(storedUser.content).includes(image.data)
  )
    throw new Error('packaged image prompt was not resized and sent as an image')
  console.log('image sdk ok')
} finally {
  await imgRuntime.dispose()
}

// Tool source, shared image normalization and canonical tool types from @glows777/vela/extension-api.
const toolContent: ToolContent = [{ type: 'text', text: 'Caption' }, image]
if (new ToolExecutionResult({ source: 'smoke' }, toolContent).text !== 'Caption')
  throw new Error('packaged ToolContent API failed')
const imageTool = createTestVela({ responses: [fauxToolCall('read', { path: 'image.dat' }), fauxText('read')] })
await writeFile(join(imageTool.cwd, 'image.dat'), Buffer.from(image.data, 'base64'))
await imageTool.run('Read image.dat')
const toolFiles = imageTool.model.calls[1]?.prompt.flatMap((m) => m.role === 'tool' ? m.content.flatMap((p) => p.type === 'tool-result' && p.output.type === 'content' ? p.output.value.filter((c) => c.type === 'file' && c.mediaType.startsWith('image/')) : []) : []) ?? []
if (toolFiles.length !== 1 || JSON.stringify(imageTool.session.messages).includes(image.data))
  throw new Error('packaged read image was not resized and sent')
console.log('tool image sdk ok')

// grep / find run ripgrep / fd as child processes
const s = createTestVela({
  session: { tools: ['+find', '+grep'] },
  files: { 'src/a.ts': 'export const answer = 42' },
  responses: [
    [fauxToolCall('find', { pattern: '*.ts' }), fauxToolCall('grep', { pattern: 'answer' })],
    fauxText('ok'),
  ],
})
await s.run('search')
const searched = Object.fromEntries(
  (s.model.calls[1]?.toolResults ?? []).map((r) => [r.toolName, JSON.stringify(r.output)]),
)
if (!searched['find']?.includes('src/a.ts') || !searched['grep']?.includes('src/a.ts:1: export const answer = 42'))
  throw new Error(\`grep / find results missing: \${JSON.stringify(searched)}\`)

// MCP stdio server configured in <agentDir>/config.json lazy-loads @modelcontextprotocol/sdk on demand
const mcpAgentDir = await mkdtemp(join(tmpdir(), 'vela-mcp-smoke-'))
try {
  await writeFile(
    join(mcpAgentDir, 'config.json'),
    JSON.stringify({
      mcpServers: {
        local: {
          command: process.execPath,
          args: ['server.ts'],
          exposure: 'direct',
        },
      },
    }),
  )
  const mcpModel = createFauxModel({
    responses: [fauxToolCall('mcp__local__echo', { text: 'stdio works' }), fauxText('done')],
  })
  const mcpRuntime = createRuntime({
    agentDir: mcpAgentDir,
    defaultModel: mcpModel,
    trustOverride: () => true,
  })
  try {
    await mcpRuntime.ready()
    const proj = await mcpRuntime.projects.create({
      name: 'McpSmoke',
      cwd: process.cwd(),
      hubSessionId: true,
    })
    await mcpRuntime.prompt(proj.hubSessionId!, { text: 'echo' })
    await mcpRuntime.waitForIdle(proj.hubSessionId!)
    const echoResult = (mcpModel.calls[1]?.toolResults ?? []).find((r) => r.toolName === 'mcp__local__echo')
    const outputText = JSON.stringify(echoResult?.output ?? '')
    if (!echoResult || outputText.includes('AI_NoSuchToolError') || !outputText.includes('stdio works'))
      throw new Error(\`mcp tool result missing or failed: \${JSON.stringify(mcpModel.calls[1]?.toolResults)}\`)
    console.log('mcp stdio sdk ok')
  } finally {
    await mcpRuntime.dispose()
  }
} finally {
  rmSync(mcpAgentDir, { recursive: true, force: true })
}

// Lark fake transport round trip (incoming message -> reply)
let larkReceive: ((event: LarkMessageEvent) => void) | undefined
const larkSent: string[] = []
const receipt = () => ({ messageId: 'reply', createTime: String(Date.now()) })
const transport: LarkTransport = {
  async start(next) { larkReceive = next },
  stop() {},
  async getBotId() { return 'ou_bot' },
  async getSenderName() { return 'Alice' },
  async send(_chat, text) { larkSent.push(text); return receipt() },
  async reply(_message, text) { larkSent.push(text); return receipt() },
  async startTopic() { return { ...receipt(), rootId: 'root', threadId: 'thread' } },
  async forward() { return receipt() },
  async sendCard() { return 'card' },
  async patchCard() {},
  async addReaction() { return 'reaction' },
  async removeReaction() {},
  async getResource() { return Readable.from([Buffer.from('ok')]) },
  async listTopicMessages() { return { items: [] } },
  async searchMessages() { return { items: [] } },
  async listMessages() { return [] },
}
const larkOptions: LarkChannelAdapterOptions = {
  appId: 'offline',
  owners: ['ou_alice'],
  transport,
}
const larkRuntime = createRuntime({
  ephemeral: true,
  defaultModel: createFauxModel({ responses: [fauxText('lark received')] }),
  mcp: false,
})
try {
  await larkRuntime.ready()
  await larkRuntime.registerChannel(createLarkChannelAdapter(larkOptions))
  larkReceive!({
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_alice' } },
    message: {
      chat_id: 'direct',
      chat_type: 'p2p',
      message_id: 'm1',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
      create_time: String(Date.now()),
    },
  })
  const deadline = Date.now() + 5_000
  while (!larkSent.some((text) => text.includes('lark received')) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
  assert(larkSent.some((text) => text.includes('lark received')))
  console.log('lark fake transport round trip ok')
} finally {
  await larkRuntime.dispose()
}

// startDaemonServer() + connectRuntime() IPC round trip inside consumer package
const ipcAgentDir = await mkdtemp(join(tmpdir(), 'vela-ipc-smoke-'))
try {
  const server = await startDaemonServer({
    agentDir: ipcAgentDir,
    defaultModel: createFauxModel({ responses: [fauxText('ipc daemon hello')] }),
    enableLark: false,
    enableWebhooks: false,
    registerSignalHandlers: false,
  })
  const ipcClient = await connectRuntime({ agentDir: ipcAgentDir })
  try {
    const sess = await ipcClient.sessions.create({ name: 'ipc-smoke' })
    await ipcClient.prompt(sess.id, { text: 'hi ipc' })
    await ipcClient.waitForIdle(sess.id)
    const msgPage = await ipcClient.sessions.messages({ sessionId: sess.id })
    assert(msgPage.messages.some((m) => m.text.includes('ipc daemon hello')))
    console.log('startDaemonServer + connectRuntime IPC ok')
  } finally {
    await ipcClient.dispose()
    await server.close('smoke-done')
  }
} finally {
  rmSync(ipcAgentDir, { recursive: true, force: true })
}

const runtimeOpts: CreateRuntimeOptions = {
  ephemeral: true,
  defaultModel: createFauxModel({ responses: [fauxText('runtime ok')] }),
  mcp: false,
}
const rt: LocalVelaRuntime = createRuntime(runtimeOpts)
try {
  const rtSession = await rt.sessions.create({ name: 'smoke' })
  await rt.prompt(rtSession.id, { text: 'hello runtime' })
  await rt.waitForIdle(rtSession.id)
  const page = await rt.sessions.messages({ sessionId: rtSession.id })
  assert(page.messages.some((msg) => msg.text.includes('runtime ok')))
  console.log('createRuntime ephemeral ok')
} finally {
  await rt.dispose()
}

// Verify ./legacy-desktop was completely removed from the packed package.
const installedPkgPath = join(process.cwd(), 'node_modules/@glows777/vela/package.json')
const installedPkg = JSON.parse(readFileSync(installedPkgPath, 'utf8')) as {
  exports: Record<string, unknown>
}
assert.equal('./legacy-desktop' in installedPkg.exports, false)
assert.equal(
  existsSync(join(process.cwd(), 'node_modules/@glows777/vela/dist/legacy-desktop.js')),
  false,
)

await cleanupTestVelas()
console.log('sdk ok')
`

const NODE_TSCONFIG = {
  compilerOptions: {
    target: 'ES2023',
    lib: ['ES2023'],
    types: ['node'],
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    noEmit: true,
    strict: true,
    exactOptionalPropertyTypes: true,
    noPropertyAccessFromIndexSignature: true,
    noUncheckedIndexedAccess: true,
    noImplicitOverride: true,
    verbatimModuleSyntax: true,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
  },
  include: ['smoke.ts'],
}

const BUN_TSCONFIG = {
  compilerOptions: {
    lib: ['ESNext'],
    types: ['bun'],
    target: 'ESNext',
    module: 'Preserve',
    moduleDetection: 'force',
    jsx: 'react-jsx',
    allowJs: true,
    moduleResolution: 'bundler',
    allowImportingTsExtensions: true,
    verbatimModuleSyntax: true,
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    noFallthroughCasesInSwitch: true,
    noUncheckedIndexedAccess: true,
    noImplicitOverride: true,
  },
}

const packed = await (async () => {
  await $`bun run build`.cwd(ROOT)
  return packWorkspaces(ROOT, work)
})()
const byName = new Map(packed.map((p) => [p.name, p]))
const byTar = new Map(packed.map((p) => ['/tar/' + p.key + '.tgz', p]))
let registryURL = ''
const registry = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const archive = byTar.get(url.pathname)
    if (archive) return new Response(Bun.file(archive.tarball))
    const name = decodeURIComponent(url.pathname.slice(1))
    const pkg = byName.get(name)
    if (!pkg) return new Response('not found', { status: 404 })
    return Response.json({
      name: pkg.name,
      'dist-tags': { latest: pkg.version },
      versions: {
        [pkg.version]: {
          ...pkg.manifest,
          dist: {
            tarball: registryURL + '/tar/' + pkg.key + '.tgz',
            integrity: pkg.integrity,
          },
        },
      },
    })
  },
})
registryURL = `http://127.0.0.1:${registry.port}`

async function cli(app: string, runtime: string, version: string) {
  const home = join(app, 'home')
  await mkdir(home, { recursive: true })
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    VELA_DIR: join(home, '.vela'),
    VELA_MODEL: 'mock',
    VELA_OFFLINE: '1',
  }
  try {
    const output =
      await $`${runtime} ./node_modules/.bin/vela -p hello < /dev/null`
        .cwd(app)
        .env(env)
        .text()
    if (!output.trim()) throw new Error('CLI printed no answer')
    const actual = (
      await $`${runtime} ./node_modules/.bin/vela --version`
        .cwd(app)
        .env(env)
        .text()
    ).trim()
    if (actual !== version)
      throw new Error(`CLI version ${actual}, expected ${version}`)
    const file = join(app, 'node_modules/@glows777/vela/dist/cli/main.js')
    if (!((await Bun.file(file).stat()).mode & 0o111))
      throw new Error('CLI bin lost executable mode')
    const retired = await $`${runtime} ./node_modules/.bin/vela serve`
      .cwd(app)
      .env(env)
      .nothrow()
      .quiet()
    if (
      retired.exitCode !== 2 ||
      !retired.stderr.toString().includes('vela daemon')
    )
      throw new Error(
        `retired serve check failed (${retired.exitCode}): ${retired.stderr.toString()}`,
      )

    const daemonDir = join(app, 'daemon-agent')
    await mkdir(daemonDir, { recursive: true })
    const scenario = join(app, 'daemon-faux.json')
    await writeFile(
      scenario,
      JSON.stringify({ responses: [{ text: 'daemon received' }] }),
    )
    const daemonEnv = { ...env, VELA_MODEL: `faux:${scenario}` }
    const proc = Bun.spawn(
      [
        runtime,
        './node_modules/.bin/vela',
        '--agent-dir',
        daemonDir,
        'daemon',
        'run',
      ],
      {
        cwd: app,
        env: daemonEnv,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    let stderr = ''
    const reading = (async () => {
      for await (const chunk of proc.stderr)
        stderr += new TextDecoder().decode(chunk)
    })()
    const stdout = new Response(proc.stdout).text()
    try {
      const deadline = Date.now() + 20000
      while (true) {
        if (Date.now() > deadline || proc.exitCode !== null)
          throw new Error(`packed daemon failed to start: ${stderr}`)
        const status =
          await $`${runtime} ./node_modules/.bin/vela --agent-dir ${daemonDir} daemon status`
            .cwd(app)
            .env(daemonEnv)
            .nothrow()
            .quiet()
        if (
          status.exitCode === 0 &&
          status.stdout.toString().includes('running')
        )
          break
        await new Promise((done) => setTimeout(done, 50))
      }
      const reply = (
        await $`${runtime} ./node_modules/.bin/vela --agent-dir ${daemonDir} -p ping < /dev/null`
          .cwd(app)
          .env(daemonEnv)
          .text()
      ).trim()
      if (reply !== 'daemon received')
        throw new Error(`packed daemon reply mismatch: ${reply}`)
      proc.kill('SIGTERM')
      const code = await proc.exited
      await reading
      if (code !== 0 || (await stdout) !== '')
        throw new Error(`packed daemon lifecycle failed (${code}): ${stderr}`)
      console.log('packaged daemon signal/disposal ok')
    } finally {
      if (proc.exitCode === null) proc.kill('SIGKILL')
      await proc.exited
      await reading
      await stdout
      await $`${runtime} ./node_modules/.bin/vela --agent-dir ${daemonDir} daemon stop`
        .cwd(app)
        .env(daemonEnv)
        .nothrow()
        .quiet()
    }
  } finally {
    await $`${runtime} ./node_modules/.bin/vela daemon stop`
      .cwd(app)
      .env(env)
      .nothrow()
      .quiet()
  }
}

async function reserveFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => {
        if (error) reject(error)
        else resolvePort(port)
      })
    })
  })
}

async function nodeDaemonSmoke(app: string) {
  const webhookPort = await reserveFreePort()
  const daemonDir = join(app, 'daemon-agent')
  await mkdir(daemonDir, { recursive: true })
  const webhookSecret = 'smoke-webhook-secret'
  await writeFile(
    join(daemonDir, 'config.json'),
    JSON.stringify({
      webhooks: {
        port: webhookPort,
        generic: { secret: '$VELA_WEBHOOK_SECRET', source: 'smoke' },
      },
    }),
  )

  const proc = Bun.spawn(
    ['node', './node_modules/.bin/vela', 'daemon', 'run'],
    {
      cwd: app,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: join(app, 'home'),
        VELA_DIR: daemonDir,
        VELA_WEBHOOK_SECRET: webhookSecret,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  let stdout = ''
  let stderr = ''
  const readingStdout = (async () => {
    for await (const chunk of proc.stdout)
      stdout += new TextDecoder().decode(chunk)
  })()
  const readingStderr = (async () => {
    for await (const chunk of proc.stderr)
      stderr += new TextDecoder().decode(chunk)
  })()
  try {
    const deadline = Date.now() + 20_000
    let webhookStatus = 0
    while (Date.now() < deadline) {
      if (proc.exitCode !== null)
        throw new Error(
          `packaged vela daemon exited before webhook check (${proc.exitCode}): ${stderr || stdout}`,
        )
      try {
        const res = await fetch(
          `http://127.0.0.1:${webhookPort}/events/generic`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-vela-delivery': 'smoke-1',
              'x-vela-signature-256': 'sha256=deadbeef',
            },
            body: JSON.stringify({ key: 'smoke:test', summary: 'hi' }),
          },
        )
        webhookStatus = res.status
        break
      } catch {
        await new Promise((done) => setTimeout(done, 50))
      }
    }
    if (webhookStatus !== 403)
      throw new Error(
        `packaged vela daemon webhook listener expected 403 on bad signature, got ${webhookStatus}: ${stderr || stdout}`,
      )

    proc.kill('SIGTERM')
    const code = await proc.exited
    await Promise.all([readingStdout, readingStderr])
    if (code !== 0)
      throw new Error(
        `packaged vela daemon SIGTERM exit failed (${code}): ${stderr || stdout}`,
      )
    console.log('packaged vela daemon webhook lifecycle ok')
  } finally {
    if (proc.exitCode === null) proc.kill('SIGKILL')
    await proc.exited
    await Promise.all([readingStdout, readingStderr])
  }
}

try {
  for (const pkg of packed)
    for (const runtime of ['node', 'bun']) {
      const app = join(work, pkg.key + '-' + runtime)
      await mkdir(app, { recursive: true })
      await writeFile(
        join(app, '.npmrc'),
        `@glows777:registry=${registryURL}/\n`,
      )
      const devDependencies = {
        typescript: tooling.devDependencies.typescript,
        zod: tooling.devDependencies.zod,
        [runtime === 'node' ? '@types/node' : '@types/bun']:
          tooling.devDependencies[
            runtime === 'node' ? '@types/node' : '@types/bun'
          ],
      }
      await writeFile(
        join(app, 'package.json'),
        JSON.stringify({
          name: 'consumer-' + pkg.key + '-' + runtime,
          private: true,
          type: 'module',
          dependencies: { [pkg.name]: pkg.version },
          devDependencies,
        }),
      )
      await writeFile(
        join(app, 'tsconfig.json'),
        JSON.stringify(runtime === 'node' ? NODE_TSCONFIG : BUN_TSCONFIG),
      )
      await writeFile(join(app, 'smoke.ts'), SMOKE)
      await writeFile(
        join(app, 'server.ts'),
        await readFile(join(ROOT, 'test/fixtures/mcp-echo-server.ts')),
      )
      console.log(`--- ${pkg.key}: ${runtime} fresh install`)
      if (runtime === 'node')
        await $`npm install --no-audit --no-fund --loglevel=error`.cwd(app)
      else
        await $`bun install`.cwd(app).env({
          ...process.env,
          BUN_INSTALL_CACHE_DIR: join(work, 'bun-cache'),
        })
      await $`./node_modules/.bin/tsc -p .`.cwd(app)
      if (pkg.name === '@glows777/vela' && runtime === 'node') {
        const distRoot = join(app, 'node_modules/@glows777/vela/dist')
        for (const rel of [
          'index.d.ts',
          'extension-api.d.ts',
          'driver/vela-session.d.ts',
          'driver/tools/registry.d.ts',
          'driver/tools/types.d.ts',
        ]) {
          const text = await readFile(join(distRoot, rel), 'utf8')
          if (
            text.includes('SessionScope') ||
            text.includes('InternalSessionOptions') ||
            /\bscope\s*[?:]/.test(text) ||
            /\bget scope\s*\(/.test(text)
          ) {
            throw new Error(`Unexpected scope declaration leaked in ${rel}`)
          }
        }
        const optionsDts = await readFile(
          join(distRoot, 'driver/session/options.d.ts'),
          'utf8',
        )
        const sessionOptionsBlock = optionsDts.match(
          /export interface SessionOptions \{[\s\S]*?\n\}/,
        )?.[0]
        if (
          !sessionOptionsBlock ||
          sessionOptionsBlock.includes('SessionScope') ||
          /\bscope\s*[?:]/.test(sessionOptionsBlock)
        ) {
          throw new Error(
            'Unexpected scope declaration leaked on SessionOptions',
          )
        }
      }
      await $`${runtime} smoke.ts`.cwd(app)
      await cli(app, runtime, pkg.version)
      if (pkg.name === '@glows777/vela' && runtime === 'node')
        await nodeDaemonSmoke(app)
      console.log(`PASS ${pkg.name} on ${runtime}`)
    }
  console.log('packed @glows777/vela consumer checks passed on Node and Bun')
} finally {
  registry.stop(true)
  await rm(work, { recursive: true, force: true })
}
