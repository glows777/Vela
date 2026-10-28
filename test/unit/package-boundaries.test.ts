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
    'package.json': JSON.stringify({
      private: true,
      workspaces: ['packages/*'],
    }),
    'packages/core/package.json': JSON.stringify({
      name: '@glows777/vela-core',
      version: '0.4.0',
      exports: {
        '.': { import: './dist/index.js' },
        './extension-api': { import: './dist/extension-api.js' },
      },
      dependencies: {},
    }),
    'packages/core/src/index.ts': 'export const core = true',
    'packages/core/src/extension-api.ts':
      'export interface Session {\n/** @internal */\nregistry: object\n}',
    'packages/core/dist/extension-api.d.ts':
      'export interface Session {\n/** @internal */\nregistry: object\n}',
    'packages/channels/package.json': JSON.stringify({
      name: '@glows777/vela-channels',
      version: '0.4.0',
      exports: { '.': { import: './dist/index.js' } },
      dependencies: { '@glows777/vela-core': 'workspace:*' },
    }),
    'packages/channels/src/index.ts':
      "export {core} from '@glows777/vela-core'",
    'packages/vela/package.json': JSON.stringify({
      name: '@glows777/vela',
      version: '0.4.0',
      exports: { '.': { import: './dist/index.js' } },
      dependencies: { '@glows777/vela-core': 'workspace:*' },
    }),
    'packages/vela/src/index.ts': 'export const product = true',
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

test('boundary checker accepts downward public package edges', async () => {
  expect(await errors({})).toEqual([])
})
for (const [label, files, pattern] of [
  [
    'type-only upward edge',
    {
      'packages/core/src/index.ts':
        "import type {X} from '@glows777/vela'; export type Y=X",
    },
    /direction/,
  ],
  [
    'mixed export upward edge',
    {
      'packages/core/src/index.ts':
        "export { type X, product } from '@glows777/vela'",
    },
    /direction/,
  ],
  [
    'private subpath',
    {
      'packages/channels/src/index.ts':
        "export {} from '@glows777/vela-core/private'",
    },
    /export/,
  ],
  [
    'relative source escape',
    {
      'packages/channels/src/index.ts':
        "export {} from '../../core/src/index.ts'",
    },
    /source escape/,
  ],
  [
    'dynamic heavy import',
    {
      'packages/core/src/index.ts':
        "export const load=()=>import('@modelcontextprotocol/sdk/client/index.js')",
    },
    /heavy/,
  ],
  [
    'require heavy import',
    {
      'packages/core/src/index.ts':
        "const sdk=require('@larksuiteoapi/node-sdk');export {sdk}",
    },
    /heavy/,
  ],
  [
    'eager Photon',
    {
      'packages/core/src/index.ts':
        "export * from '@silvia-odwyer/photon-node'",
    },
    /Photon/,
  ],
  [
    'light builtin private source',
    {
      'packages/core/src/extensions/memory/index.ts':
        "export {} from '../../index.ts'",
    },
    /light builtin/,
  ],
  [
    'light builtin root escape',
    {
      'packages/core/src/extensions/web/index.ts':
        "export {} from '@glows777/vela-core'",
    },
    /light builtin/,
  ],
] as const)
  test(`boundary checker rejects ${label}`, async () => {
    expect((await errors(files)).join('\n')).toMatch(pattern)
  })
test('light builtin cannot access an internal member through a public session type', async () => {
  expect(
    (
      await errors({
        'packages/core/src/extensions/memory/index.ts':
          "import type {Session} from '@glows777/vela-core/extension-api'; export const leak=(session:Session)=>session.registry",
      })
    ).join('\n'),
  ).toMatch(/internal member/)
})

test('Photon remains allowed only behind a lazy import', async () => {
  expect(
    await errors({
      'packages/core/src/index.ts':
        "export const image=()=>import('@silvia-odwyer/photon-node')",
    }),
  ).toEqual([])
})

test('light builtin cannot bypass an internal member check with string indexing', async () => {
  expect(
    (
      await errors({
        'packages/core/src/extensions/memory/index.ts':
          "import type {Session} from '@glows777/vela-core/extension-api'; export const leak=(session:Session)=>session['registry']",
      })
    ).join('\n'),
  ).toMatch(/internal member/)
})
test('source aliases cannot hide a private workspace import', async () => {
  expect(
    (
      await errors({
        'tsconfig.json': JSON.stringify({
          compilerOptions: { paths: { '@hidden/*': ['packages/core/src/*'] } },
        }),
      })
    ).join('\n'),
  ).toMatch(/source alias/)
})
test('absolute private source imports are not package contracts', async () => {
  expect(
    (
      await errors({
        'packages/channels/src/index.ts':
          "export {} from '/tmp/private-core.ts'",
      })
    ).join('\n'),
  ).toMatch(/source escape/)
})
