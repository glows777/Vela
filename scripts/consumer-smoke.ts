/**
 * Consumer smoke test: use Vela the way an external project would.
 * Builds and packs all six packages, serving their unchanged tarballs from a disposable scoped registry.
 * Each package is installed alone into fresh Node and Bun projects outside the workspace.
 * The external dependency registry stays unchanged. It installs into fresh,
 * empty projects (not workspace links):
 * - Node project (npm install): strict NodeNext tsconfig (exactOptionalPropertyTypes etc.,
 *   no @types/bun) type-checks `@glows777/vela` / `@glows777/vela/testing`, then runs an
 *   SDK session and the CLI `vela -p` under Node;
 * - Bun project (bun install): default `bun init` tsconfig, runs the same SDK session and CLI under Bun.
 * Installing dependencies needs the network, so this is not part of `bun run test`;
 * CI runs it separately: `bun run smoke:consumer`.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { createVela, memory, type VelaEvent, type VelaExtension, type ImageContent, ToolExecutionResult, type ToolContent } from '@glows777/vela'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanupTestVelas, createFauxModel, createTestVela, fauxText, fauxToolCall } from '@glows777/vela/testing'
import { z } from 'zod'

const hello: VelaExtension = (vela) => {
  vela.registerTool({
    name: 'greet',
    description: 'greet someone',
    inputSchema: z.object({ name: z.string() }),
    annotations: { readOnlyHint: true },
    execute: async ({ name }: { name: string }) => \`hi \${name}\`,
  })
}

const model = createFauxModel({
  responses: [fauxToolCall('hello_greet', { name: 'Vela' }), fauxText('done')],
})
const vela = createVela({ model, extensions: [hello, memory()] })
const session = vela.session('default')
const types: string[] = []
session.subscribe((e: VelaEvent) => { types.push(e.type) })
await session.prompt('say hi')
// Types really resolve from the .d.ts (not any); otherwise the @ts-expect-error below reports "unused"
const typeChecks = () => {
  // @ts-expect-error prompt only accepts strings
  void session.prompt(42)
}
void typeChecks
// @ts-expect-error no such event type
const bogus: VelaEvent = { type: 'no_such_event' }
void bogus
await vela.dispose()
if (!types.includes('tool_execution_end') || types.at(-1) !== 'agent_settled')
  throw new Error(\`unexpected events: \${types.join(',')}\`)
if (!JSON.stringify(model.calls[1]?.prompt).includes('hi Vela'))
  throw new Error('tool result did not reach the model')

const t = createTestVela({ responses: [fauxText('ok')] })
await t.run('hello')
if (t.lastAssistantText() !== 'ok') throw new Error('createTestVela failed')

// Photon WASM must resolve from the installed package under both Node and Bun.
const image: ImageContent = { type: 'image', data: '${IMAGE}', mimeType: 'image/png' }
const pictured = createTestVela({ responses: [fauxText('image received')] })
await pictured.session.prompt('Describe the image', { images: [image] })
const files = pictured.model.calls[0]?.prompt.flatMap((m) => m.role === 'user' ? m.content.filter((p) => p.type === 'file' && p.mediaType.startsWith('image/')) : []) ?? []
if (files.length !== 1 || JSON.stringify(pictured.session.messages[0]).includes(image.data))
  throw new Error('packaged image prompt was not resized and sent as an image')
console.log('image sdk ok')

// Tool source, shared image normalization and canonical tool types from the real package.
const toolContent: ToolContent = [{ type: 'text', text: 'Caption' }, image]
if (new ToolExecutionResult({ source: 'smoke' }, toolContent).text !== 'Caption')
  throw new Error('packaged ToolContent API failed')
const imageTool = createTestVela({ responses: [fauxToolCall('read_file', { path: 'image.dat' }), fauxText('read')] })
await writeFile(join(imageTool.cwd, 'image.dat'), Buffer.from(image.data, 'base64'))
await imageTool.run('Read image.dat')
const toolFiles = imageTool.model.calls[1]?.prompt.flatMap(m => m.role === 'tool' ? m.content.flatMap(p => p.type === 'tool-result' && p.output.type === 'content' ? p.output.value.filter(c => c.type === 'file' && c.mediaType.startsWith('image/')) : []) : []) ?? []
if (toolFiles.length !== 1 || JSON.stringify(imageTool.session.messages).includes(image.data))
  throw new Error('packaged read_file image was not resized and sent')
console.log('tool image sdk ok')

// rag extension: sqlite-vec loads via bun:sqlite on Bun / node:sqlite on Node (src/extensions/rag/sqlite.ts)
const r = createTestVela({
  embedder: true,
  files: { 'guide.md': 'Vela runs on Node and Bun.' },
  responses: [
    fauxToolCall('rag_ingest', { path: 'guide.md' }),
    fauxToolCall('rag_search', { query: 'runs on Node' }),
    fauxText('ok'),
  ],
})
await r.run('ingest and search')
if (!JSON.stringify(r.model.calls[2]?.prompt).includes('Vela runs on Node and Bun.'))
  throw new Error('rag_search did not return the ingested text')

// grep / find run ripgrep / fd as child processes (src/tools/search.ts)
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
await cleanupTestVelas()
console.log('sdk ok')
`

// Node project: NodeNext with every strict option that can be enabled. skipLibCheck stays on
// (the .d.ts of dependencies like ai fail under exactOptionalPropertyTypes / no DOM lib);
// the @ts-expect-error lines in smoke.ts make sure the types are not any
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

// The tsconfig `bun init` generates (the Bun project default); TypeScript 6 defaults types to empty, so list bun explicitly
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

const coreSmoke = SMOKE.replaceAll(
  "'@glows777/vela/testing'",
  "'@glows777/vela-core/testing'",
).replaceAll("'@glows777/vela'", "'@glows777/vela-core'")
const ragStart = coreSmoke.indexOf('// rag extension:')
const ragEnd = coreSmoke.indexOf('// grep / find', ragStart)
const CORE = insertCoreSubpaths(
  coreSmoke.slice(0, ragStart) + coreSmoke.slice(ragEnd),
)
function insertCoreSubpaths(source: string) {
  return (
    `
import {defineJsonSchemaTool} from '@glows777/vela-core/extension-api'
import {imageMimeType,imageMetadata,isBinaryFile} from '@glows777/vela-core/images'
import {inspectVela,inspectSession} from '@glows777/vela-core/diagnostics'
if(typeof defineJsonSchemaTool!=='function'||typeof imageMimeType!=='function'||typeof imageMetadata!=='function'||typeof isBinaryFile!=='function')throw new Error('missing public core subpath')
` +
    source.replace(
      'await vela.dispose()',
      "if(!inspectVela(vela).tools.length||(await inspectSession(vela,session)).windowTokens<=0)throw new Error('diagnostic consumer failed');await vela.dispose()",
    )
  )
}
const CHANNELS = `
import assert from 'node:assert/strict'
import {createChannelVela,type ChannelExtension,type IncomingMessage} from '@glows777/vela-channels'
import {drainChannels} from '@glows777/vela-channels/testing'
import {createFauxModel,fauxText} from '@glows777/vela-core/testing'
let receive:((m:IncomingMessage)=>void)|undefined;let stopped=0;const replies:string[]=[]
const probe:ChannelExtension=api=>api.registerChannel({name:'probe',description:'standard adapter',start(){},stop(){stopped++},onMessage(next){receive=next},async send(m){replies.push(m.text)}})
const vela=createChannelVela({contextFiles:false,model:createFauxModel({responses:[fauxText('channel received')]}),extensions:[probe]})
try{await vela.startChannels();assert.deepEqual(vela.runningChannels(),['probe']);receive!({channelId:'room',senderId:'visitor',senderName:'Visitor',text:'hello'});await drainChannels(vela);assert(replies.some(text=>text.includes('channel received')));assert.equal(vela.sessions()[0]?.scope?.kind,'private')}finally{await vela.dispose()}
assert.equal(stopped,1);console.log('standard channel sdk ok')
`
const LARK = `
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {feishu,type FeishuOptions,type FeishuTransport,type FeishuMessageEvent} from '@glows777/vela-lark'
import {createChannelVela} from '@glows777/vela-channels'
import {drainChannels} from '@glows777/vela-channels/testing'
import {createFauxModel,fauxText} from '@glows777/vela-core/testing'
let receive:(event:FeishuMessageEvent)=>void=()=>{throw new Error('transport not started')};const sent:string[]=[]
const receipt=()=>({messageId:'reply',createTime:String(Date.now())})
const transport:FeishuTransport={
 async start(next){receive=next},stop(){},async getBotId(){return 'ou_bot'},async getSenderName(){return 'Alice'},
 async send(_chat,text){sent.push(text);return receipt()},async reply(_message,text){sent.push(text);return receipt()},
 async startTopic(){return {...receipt(),rootId:'root',threadId:'thread'}},async forward(){return receipt()},
 async sendCard(){return 'card'},async patchCard(){},async addReaction(){return 'reaction'},async removeReaction(){},
 async getResource(){return Readable.from([])},async listTopicMessages(){return {items:[]}},async searchMessages(){return {items:[]}},async listMessages(){return []},
}
const options:FeishuOptions={appId:'offline',owners:['ou_alice'],transport}
const vela=createChannelVela({contextFiles:false,model:createFauxModel({responses:[fauxText('lark received')]}),extensions:[feishu(options)]})
try{await vela.startChannels();receive({sender:{sender_type:'user',sender_id:{open_id:'ou_alice'}},message:{chat_id:'direct',chat_type:'p2p',message_id:'incoming',message_type:'text',content:JSON.stringify({text:'hello'}),create_time:String(Date.now())}});await drainChannels(vela);assert(sent.some(text=>text.includes('lark received')))}finally{await vela.dispose()}
console.log('lark fake transport sdk ok')
`
const MCP = `
import assert from 'node:assert/strict'
import {mcp,type McpOptions} from '@glows777/vela-mcp'
import {createTestVela,createFauxEmbedder,fauxToolCall,fauxText} from '@glows777/vela-core/testing'
const options:McpOptions={servers:{local:{command:process.execPath,args:['server.ts'],exposure:'direct'}}}
const t=createTestVela({cwd:process.cwd(),dataDir:'.mcp-data',extensions:[mcp(options)],responses:[fauxToolCall('mcp__local__echo',{text:'stdio works'}),fauxText('done')]})
try{await t.run('echo');assert(JSON.stringify(t.model.calls[1]?.prompt).includes('stdio works'));console.log('mcp stdio sdk ok')}finally{await t.cleanup()}
`
const RAG = `
import assert from 'node:assert/strict'
import {rag,type EmbeddingFn} from '@glows777/vela-rag'
import {createTestVela,createFauxEmbedder,fauxToolCall,fauxText} from '@glows777/vela-core/testing'
const embedder:EmbeddingFn=createFauxEmbedder()
const t=createTestVela({extensions:[rag({embedder})],files:{'guide.md':'Vela runs on Node and Bun.'},responses:[fauxToolCall('rag_ingest',{path:'guide.md'}),fauxToolCall('rag_search',{query:'runs on Node'}),fauxText('ok')]})
try{await t.run('ingest and search');assert(JSON.stringify(t.model.calls[2]?.prompt).includes('Vela runs on Node and Bun.'));console.log('rag sqlite vector sdk ok')}finally{await t.cleanup()}
`
const checks: Record<string, string> = {
  core: CORE,
  channels: CHANNELS,
  lark: LARK,
  mcp: MCP,
  rag: RAG,
  vela: SMOKE,
}
const forbidden = [
  '@larksuiteoapi/node-sdk',
  '@modelcontextprotocol/sdk',
  'sqlite-vec',
  '@earendil-works/pi-tui',
]
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
async function assertLightInstall(app: string) {
  const report = await $`npm ls --all --json`.cwd(app).quiet().nothrow()
  if (report.exitCode !== 0)
    throw new Error(
      'installed dependency tree is invalid: ' + report.stderr.toString(),
    )
  const tree = JSON.parse(report.stdout.toString())
  const visit = (node: { dependencies?: Record<string, unknown> }) => {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      if (forbidden.includes(name))
        throw new Error(`light install contains ${name}`)
      visit(child as typeof node)
    }
  }
  visit(tree)
}
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
}
try {
  const only = process.argv.includes('--only')
    ? new Set(process.argv[process.argv.indexOf('--only') + 1]!.split(','))
    : undefined
  for (const pkg of packed.filter((p) => !only || only.has(p.key)))
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
        ...(pkg.key === 'mcp'
          ? {
              '@modelcontextprotocol/sdk':
                tooling.devDependencies['@modelcontextprotocol/sdk'],
            }
          : {}),
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
      await writeFile(join(app, 'smoke.ts'), checks[pkg.key]!)
      if (pkg.key === 'mcp')
        await cpFixture(
          'test/fixtures/mcp-echo-server.ts',
          join(app, 'server.ts'),
        )
      console.log(`--- ${pkg.key}: ${runtime} fresh install`)
      if (runtime === 'node')
        await $`npm install --no-audit --no-fund --loglevel=error`.cwd(app)
      else
        await $`bun install`.cwd(app).env({
          ...process.env,
          BUN_INSTALL_CACHE_DIR: join(work, 'bun-cache'),
        })
      if (pkg.key === 'core' || pkg.key === 'channels')
        await assertLightInstall(app)
      await $`./node_modules/.bin/tsc -p .`.cwd(app)
      await $`${runtime} smoke.ts`.cwd(app)
      if (pkg.key === 'vela') await cli(app, runtime, pkg.version)
      console.log(`PASS ${pkg.name} on ${runtime}`)
    }
  console.log(
    only
      ? 'selected packed workspace consumer checks passed'
      : 'all six packed workspace consumer checks passed',
  )
} finally {
  registry.stop(true)
  await rm(work, { recursive: true, force: true })
}
async function cpFixture(source: string, destination: string) {
  await writeFile(destination, await readFile(join(ROOT, source)))
}
