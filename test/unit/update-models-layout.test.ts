import { expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { $ } from 'bun'

test('offline model catalog generation writes the core package, leaving flat src absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vela-catalog-layout-'))
  try {
    await mkdir(join(root, 'scripts'))
    await mkdir(join(root, 'package/dist/providers/data'), { recursive: true })
    for (const provider of [
      'anthropic',
      'openai',
      'openrouter',
      'deepseek',
      'xai',
      'groq',
      'cerebras',
      'moonshotai',
      'zai',
      'minimax',
    ])
      await writeFile(
        join(root, 'package/dist/providers/data', provider + '.json'),
        '{}',
      )
    await $`tar -czf ${join(root, 'fixture.tgz')} -C ${root} package`.quiet()
    await cp(
      resolve(import.meta.dir, '../../scripts/update-models.ts'),
      join(root, 'scripts/update-models.ts'),
    )
    await writeFile(
      join(root, 'offline.ts'),
      `globalThis.fetch=async(input)=>String(input).includes('registry.npmjs.org')?Response.json({dist:{tarball:'https://offline.invalid/fixture.tgz'}}):new Response(await Bun.file(${JSON.stringify(join(root, 'fixture.tgz'))}).arrayBuffer())`,
    )
    const result =
      await $`${process.execPath} --preload ${join(root, 'offline.ts')} ${join(root, 'scripts/update-models.ts')}`.quiet()
    expect(result.exitCode).toBe(0)
    const output = Bun.file(
      join(root, 'packages/core/src/models/catalog.generated.ts'),
    )
    expect(await output.exists()).toBe(true)
    expect(await output.text()).toContain('MODEL_CATALOG')
    expect(
      await Bun.file(join(root, 'src/models/catalog.generated.ts')).exists(),
    ).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
