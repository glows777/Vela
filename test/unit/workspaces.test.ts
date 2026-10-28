import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const names = ['core', 'channels', 'mcp', 'rag', 'lark', 'vela']

test('six lockstep packages use workspace dependencies and explicit built entry contracts', async () => {
  const manifest = JSON.parse(await readFile(`${root}/package.json`, 'utf8'))
  expect(manifest.private).toBe(true)
  expect(manifest.workspaces).toEqual(['packages/*'])
  const versions = new Set<string>()
  for (const name of names) {
    const pkg = JSON.parse(
      await readFile(`${root}/packages/${name}/package.json`, 'utf8'),
    )
    expect(pkg.name).toBe(
      name === 'vela' ? '@glows777/vela' : `@glows777/vela-${name}`,
    )
    versions.add(pkg.version)
    for (const [dependency, version] of Object.entries(pkg.dependencies ?? {}))
      if (dependency.startsWith('@glows777/vela'))
        expect(version).toBe('workspace:*')
    for (const [subpath, conditions] of Object.entries(pkg.exports) as [
      string,
      { types: string; import: string },
    ][]) {
      expect(subpath).not.toContain('*')
      expect(conditions.types).toMatch(/^\.\/dist\/.*\.d\.ts$/)
      expect(conditions.import).toMatch(/^\.\/dist\/.*\.js$/)
    }
    expect(
      await Bun.file(`${root}/packages/${name}/api/public-api.txt`).exists(),
    ).toBe(true)
  }
  expect(versions.size).toBe(1)
})

test('real source boundaries satisfy the permanent checker', async () => {
  const { checkBoundaries } = await import('../../scripts/check-boundaries.ts')
  expect(await checkBoundaries(root)).toEqual([])
})
