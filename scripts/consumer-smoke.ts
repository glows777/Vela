/**
 * Consumer smoke test: use Vela the way an external project would.
 * Runs `bun run build`, packs this repo into a tarball, and installs it into two fresh,
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

const ROOT = resolve(import.meta.dir, '..')
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const work = await mkdtemp(join(tmpdir(), 'vela-consumer-'))

const SMOKE = `
import { createVela, memory, type VelaEvent, type VelaExtension } from '@glows777/vela'
import { cleanupTestVelas, createFauxModel, createTestVela, fauxText, fauxToolCall } from '@glows777/vela/testing'
import { z } from 'zod'

const hello: VelaExtension = (vela) => {
  vela.registerTool({
    name: 'greet',
    description: 'greet someone',
    inputSchema: z.object({ name: z.string() }),
    isConcurrencySafe: true,
    isReadOnly: true,
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
if (!types.includes('tool_result') || types.at(-1) !== 'agent_settled')
  throw new Error(\`unexpected events: \${types.join(',')}\`)
if (!JSON.stringify(model.calls[1]?.prompt).includes('hi Vela'))
  throw new Error('tool result did not reach the model')

const t = createTestVela({ responses: [fauxText('ok')] })
await t.run('hello')
if (t.lastAssistantText() !== 'ok') throw new Error('createTestVela failed')

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

async function project(
  name: string,
  tarball: string,
  devDependencies: Record<string, string>,
  tsconfig: unknown,
): Promise<string> {
  const app = join(work, name)
  await mkdir(app, { recursive: true })
  await writeFile(
    join(app, 'package.json'),
    JSON.stringify({
      name: `vela-consumer-${name}`,
      private: true,
      type: 'module',
      dependencies: { [pkg.name]: tarball, zod: pkg.dependencies.zod },
      devDependencies: { typescript: pkg.devDependencies.typescript, ...devDependencies },
    }),
  )
  await writeFile(join(app, 'tsconfig.json'), JSON.stringify(tsconfig))
  await writeFile(join(app, 'smoke.ts'), SMOKE)
  return app
}

async function cli(app: string, runtime: string): Promise<void> {
  const home = join(work, `home-${runtime}`)
  const out = await $`${runtime} ./node_modules/.bin/vela -p hello < /dev/null`
    .cwd(app)
    .env({
      ...process.env,
      HOME: home,
      VELA_DIR: join(home, '.vela'),
      VELA_MODEL: 'mock',
    })
    .text()
  if (!out.trim()) throw new Error(`vela -p (${runtime}) printed nothing`)
  console.log(out.trim())
}

try {
  await $`bun run build`.cwd(ROOT)
  const packDir = join(work, 'pack')
  await $`bun pm pack --destination ${packDir} --quiet`.cwd(ROOT)
  const tarball = join(
    packDir,
    `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`,
  )
  const files = await $`tar -tzf ${tarball}`.text()
  if (files.includes('package/src/') || files.includes('package/test/'))
    throw new Error('the package must ship dist/, not src/ or test/')
  if (!files.includes('package/LICENSE'))
    throw new Error('the package must ship the LICENSE file')

  // Skip this repo's lockfile: resolve dependencies from package.json ranges like a real consumer
  const node = await project(
    'node',
    tarball,
    { '@types/node': pkg.devDependencies['@types/node'] },
    NODE_TSCONFIG,
  )
  await $`npm install --no-audit --no-fund --loglevel=error`.cwd(node)
  console.log('--- node: tsc (NodeNext, strict)')
  await $`./node_modules/.bin/tsc -p .`.cwd(node)
  console.log('--- node: sdk')
  await $`node smoke.ts`.cwd(node)
  console.log('--- node: cli')
  await cli(node, 'node')

  const bun = await project(
    'bun',
    tarball,
    { '@types/bun': pkg.devDependencies['@types/bun'] },
    BUN_TSCONFIG,
  )
  await $`bun install`.cwd(bun)
  console.log('--- bun: tsc')
  await $`bun x tsc -p .`.cwd(bun)
  console.log('--- bun: sdk')
  await $`bun smoke.ts`.cwd(bun)
  console.log('--- bun: cli')
  await cli(bun, 'bun')
  console.log('consumer smoke ok')
} finally {
  await rm(work, { recursive: true, force: true })
}
