/**
 * 消费者冒烟测试：像外部项目一样用 Vela。
 * 把本仓库 `bun pm pack` 成 tarball，装进一个全新的空项目（不是 workspace 链接），
 * 然后在那里：tsc 检查 `vela` / `vela/testing` 的类型、用 faux 模型跑一个带扩展工具的会话、
 * 跑 CLI `vela -p`（mock 模型）。
 * 需要联网装依赖，所以不在 `bun run test` 里，CI 单独跑：`bun run smoke:consumer`。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { $ } from 'bun'

const ROOT = resolve(import.meta.dir, '..')
const pkg = await Bun.file(join(ROOT, 'package.json')).json()
const work = await mkdtemp(join(tmpdir(), 'vela-consumer-'))

const SMOKE = `
import { createVela, memory, type VelaEvent, type VelaExtension } from 'vela'
import { cleanupTestVelas, createFauxModel, createTestVela, fauxText, fauxToolCall } from 'vela/testing'
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
await vela.dispose()
if (!types.includes('tool_result') || types.at(-1) !== 'agent_settled')
  throw new Error(\`unexpected events: \${types.join(',')}\`)
if (!JSON.stringify(model.calls[1]?.prompt).includes('hi Vela'))
  throw new Error('tool result did not reach the model')

const t = createTestVela({ responses: [fauxText('ok')] })
await t.run('hello')
if (t.lastAssistantText() !== 'ok') throw new Error('createTestVela failed')
await cleanupTestVelas()
console.log('sdk ok')
`

// bun init 生成的 tsconfig（Bun 项目的默认值）；TypeScript 6 默认 types 为空，要显式写 bun
const TSCONFIG = {
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

try {
  const packDir = join(work, 'pack')
  await $`bun pm pack --destination ${packDir} --quiet`.cwd(ROOT)
  const tarball = join(packDir, `${pkg.name}-${pkg.version}.tgz`)

  const app = join(work, 'app')
  await Bun.write(
    join(app, 'package.json'),
    JSON.stringify({
      name: 'vela-consumer',
      private: true,
      type: 'module',
      dependencies: { vela: tarball, zod: pkg.dependencies.zod },
      devDependencies: {
        '@types/bun': pkg.devDependencies['@types/bun'],
        typescript: pkg.peerDependencies.typescript,
      },
    }),
  )
  await Bun.write(join(app, 'tsconfig.json'), JSON.stringify(TSCONFIG))
  await Bun.write(join(app, 'smoke.ts'), SMOKE)

  // 不用本仓库的 lockfile：和真实消费者一样按 package.json 的范围解析依赖
  await $`bun install`.cwd(app)
  console.log('--- tsc')
  await $`bun x tsc -p .`.cwd(app)
  console.log('--- sdk')
  await $`bun smoke.ts`.cwd(app)
  console.log('--- cli')
  const home = join(work, 'home')
  const out = await $`./node_modules/.bin/vela -p hello`
    .cwd(app)
    .env({
      ...process.env,
      HOME: home,
      VELA_DIR: join(home, '.vela'),
      VELA_MODEL: 'mock',
    })
    .text()
  if (!out.trim()) throw new Error('vela -p printed nothing')
  console.log(out.trim())
  console.log('consumer smoke ok')
} finally {
  await rm(work, { recursive: true, force: true })
}
