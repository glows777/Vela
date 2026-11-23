import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true })
})

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'vela-boundaries-'))
  dirs.push(root)
  const base: Record<string, string> = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        paths: {
          '@glows777/vela': ['./packages/vela/src/index.ts'],
          '@glows777/vela/extension-api': [
            './packages/vela/src/extension-api.ts',
          ],
        },
      },
    }),
    'tsconfig.build.json': JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: { paths: {} },
    }),
    'package.json': JSON.stringify({
      private: true,
      workspaces: ['packages/*'],
    }),
    'packages/vela/package.json': JSON.stringify({
      name: '@glows777/vela',
      version: '0.9.0',
      exports: {
        '.': { import: './dist/index.js' },
        './extension-api': { import: './dist/extension-api.js' },
      },
      dependencies: {},
    }),
    'packages/vela/src/index.ts': 'export const product = true',
    'packages/vela/src/extension-api.ts':
      'export interface Session {\n/** @internal */\nregistry: object\n}',
    'packages/vela/src/shared/ok.ts': 'export const shared = true',
    'packages/vela/src/db/ok.ts': "export { shared } from '../shared/ok.ts'",
    'packages/vela/src/runtime/ok.ts': "export { shared } from '../db/ok.ts'",
    'packages/vela/src/providers/ok.ts':
      "export { shared } from '../shared/ok.ts'",
    'packages/vela/src/driver/ok.ts':
      "export { shared } from '../providers/ok.ts'",
  }
  for (const [path, content] of Object.entries({ ...base, ...files })) {
    const file = join(root, path)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, content)
  }
  return root
}

async function errors(files: Record<string, string>) {
  const { checkBoundaries } = await import('../../scripts/check-boundaries.ts')
  return checkBoundaries(await fixture(files))
}

test('boundary checker accepts valid single-package layer DAG', async () => {
  expect(await errors({})).toEqual([])
})

for (const [label, files, pattern] of [
  [
    'runtime importing driver',
    {
      'packages/vela/src/runtime/bad.ts':
        "export { shared } from '../driver/ok.ts'",
    },
    /layer direction runtime -> driver/,
  ],
  [
    'runtime importing providers',
    {
      'packages/vela/src/runtime/bad.ts':
        "export { shared } from '../providers/ok.ts'",
    },
    /layer direction runtime -> providers/,
  ],
  [
    'db importing runtime',
    {
      'packages/vela/src/db/bad.ts':
        "export { shared } from '../runtime/ok.ts'",
    },
    /layer direction db -> runtime/,
  ],
  [
    'shared importing db',
    {
      'packages/vela/src/shared/bad.ts': "export { shared } from '../db/ok.ts'",
    },
    /layer direction shared -> db/,
  ],
  [
    'driver importing lark',
    {
      'packages/vela/src/lark/ok.ts': 'export const l = 1',
      'packages/vela/src/driver/bad.ts': "export { l } from '../lark/ok.ts'",
    },
    /layer direction driver -> lark/,
  ],
  [
    'AI SDK outside src/providers/',
    {
      'packages/vela/src/runtime/bad.ts':
        "import type { ModelMessage } from 'ai'; export type M = ModelMessage",
    },
    /AI SDK import "type:ai" is confined to src\/providers\//,
  ],
  [
    'AI SDK provider package outside src/providers/',
    {
      'packages/vela/src/driver/new-file.ts':
        "import { createOpenAI } from '@ai-sdk/openai'; export { createOpenAI }",
    },
    /AI SDK import "runtime:@ai-sdk\/openai" is confined to src\/providers\//,
  ],
  [
    'allowlisted file adding a new AI SDK package',
    {
      'packages/vela/src/cli/main.ts':
        "import { createOpenAI } from '@ai-sdk/openai'; export { createOpenAI }",
    },
    /AI SDK import "runtime:@ai-sdk\/openai" is confined to src\/providers\//,
  ],
  [
    'allowlisted type-only file adding a runtime AI SDK import',
    {
      'packages/vela/src/cli/main.ts':
        "import { streamText } from 'ai'; export { streamText }",
    },
    /AI SDK import "runtime:ai" is confined to src\/providers\//,
  ],
  [
    'runtime bypassing layer checks via root barrel',
    {
      'packages/vela/src/runtime/bad.ts':
        "export { product } from '@glows777/vela'",
    },
    /layer runtime may not import root barrel/,
  ],
  [
    'config importing cli (bidirectional cycle)',
    {
      'packages/vela/src/cli/ok.ts': 'export const c = 1',
      'packages/vela/src/config/bad.ts': "export { c } from '../cli/ok.ts'",
    },
    /layer direction config -> cli/,
  ],
  [
    'eager heavy dependency reachable from root entry',
    {
      'packages/vela/src/lark/transport.ts':
        "import * as lark from '@larksuiteoapi/node-sdk'; export { lark }",
      'packages/vela/src/index.ts': "export * from './lark/transport.ts'",
    },
    /heavy dependency @larksuiteoapi\/node-sdk eagerly reachable from @glows777\/vela/,
  ],
  [
    'eager pi-tui reachable from cli/main.ts',
    {
      'packages/vela/src/cli/main.ts':
        "import { Editor } from '@earendil-works/pi-tui'; export { Editor }",
    },
    /heavy dependency @earendil-works\/pi-tui eagerly reachable from cli\/main\.ts/,
  ],
  [
    'heavy dependency outside owning layer',
    {
      'packages/vela/src/runtime/bad.ts':
        "export const load = () => import('@modelcontextprotocol/sdk/client/index.js')",
    },
    /heavy dependency @modelcontextprotocol\/sdk is confined to src\/mcp\//,
  ],
  [
    'eager Photon',
    {
      'packages/vela/src/shared/img.ts':
        "export * from '@silvia-odwyer/photon-node'",
    },
    /Photon must remain lazy/,
  ],
  [
    'relative source escape',
    {
      'packages/vela/src/index.ts': "export {} from '../../../outside.ts'",
    },
    /source escape/,
  ],
  [
    'light builtin private source',
    {
      'packages/vela/src/driver/extensions/memory/index.ts':
        "export {} from '../../ok.ts'",
    },
    /light builtin/,
  ],
  [
    'light builtin root escape',
    {
      'packages/vela/src/driver/extensions/web/index.ts':
        "export {} from '@glows777/vela'",
    },
    /light builtin/,
  ],
] as const)
  test(`boundary checker rejects ${label}`, async () => {
    expect((await errors(files)).join('\n')).toMatch(pattern)
  })

test('AI SDK is allowed inside src/providers/', async () => {
  expect(
    await errors({
      'packages/vela/src/providers/client.ts':
        "import type { LanguageModel } from 'ai'; export type M = LanguageModel",
    }),
  ).toEqual([])
})

test('lazy heavy imports inside owning layers pass cold-start checks', async () => {
  expect(
    await errors({
      'packages/vela/src/lark/transport.ts':
        "export const load = () => import('@larksuiteoapi/node-sdk')",
      'packages/vela/src/shared/image.ts':
        "export const load = () => import('@silvia-odwyer/photon-node')",
      'packages/vela/src/index.ts':
        "export { load as loadLark } from './lark/transport.ts'\nexport { load as loadImage } from './shared/image.ts'",
    }),
  ).toEqual([])
})

test('light builtin cannot access an internal member through extension-api', async () => {
  expect(
    (
      await errors({
        'packages/vela/src/driver/extensions/memory/index.ts':
          "import type {Session} from '@glows777/vela/extension-api'; export const leak=(session:Session)=>session.registry",
      })
    ).join('\n'),
  ).toMatch(/internal member/)
})

test('source aliases cannot hide a private workspace import', async () => {
  expect(
    (
      await errors({
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            paths: { '@hidden/*': ['packages/vela/src/*'] },
          },
        }),
      })
    ).join('\n'),
  ).toMatch(/source alias/)
})

test('build inheriting development mappings is rejected', async () => {
  expect(
    (
      await errors({
        'tsconfig.build.json': JSON.stringify({
          extends: './tsconfig.json',
          compilerOptions: { module: 'NodeNext' },
        }),
      })
    ).join('\n'),
  ).toMatch(/explicitly clear/)
})

test('memory dream alone may import the internal usage tracker', async () => {
  expect(
    await errors({
      'packages/vela/src/driver/usage/tracker.ts': 'export const usage = true',
      'packages/vela/src/driver/extensions/memory/dream.ts':
        "export {usage} from '../../usage/tracker.ts'",
    }),
  ).toEqual([])
  for (const file of ['memory/index.ts', 'web/index.ts']) {
    expect(
      (
        await errors({
          'packages/vela/src/driver/usage/tracker.ts':
            'export const usage = true',
          [`packages/vela/src/driver/extensions/${file}`]:
            "export {usage} from '../../usage/tracker.ts'",
        })
      ).join('\n'),
    ).toMatch(/light builtin/)
  }
})

test('print mode with AGENTS.md does not load @earendil-works/pi-tui', async () => {
  const work = await mkdtemp(join(tmpdir(), 'vela-cold-print-'))
  dirs.push(work)
  const home = join(work, 'home')
  await mkdir(home, { recursive: true })
  await writeFile(join(work, 'AGENTS.md'), 'Keep answers short.\n')
  const preload = join(work, 'block-tui.ts')
  await writeFile(
    preload,
    `import { mock } from 'bun:test'\nmock.module('@earendil-works/pi-tui', () => { throw new Error('pi-tui must not load in print mode') })\n`,
  )
  const main = join(import.meta.dir, '../../packages/vela/src/cli/main.ts')
  const child = Bun.spawn(
    [process.execPath, '--preload', preload, main, '-p', 'hello'],
    {
      cwd: work,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        VELA_DIR: join(home, '.vela'),
        VELA_MODEL: 'mock',
        VELA_OFFLINE: '1',
      },
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, stderr).toBe(0)
  expect(stdout.trim().length).toBeGreaterThan(0)
  expect(stderr).not.toContain('pi-tui must not load')
})
