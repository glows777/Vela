import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')

test('single published package @glows777/vela and private desktop workspace use explicit built entry contracts', async () => {
  const manifest = JSON.parse(await readFile(`${root}/package.json`, 'utf8'))
  expect(manifest.private).toBe(true)
  expect(manifest.workspaces).toEqual(['packages/*', 'apps/*'])
  const desktop = JSON.parse(
    await readFile(`${root}/apps/desktop/package.json`, 'utf8'),
  )
  expect(desktop.private).toBe(true)
  const { readWorkspaces } = await import('../../scripts/workspaces.ts')
  expect((await readWorkspaces(root)).map((pkg) => pkg.key)).toEqual(['vela'])
  const pkg = JSON.parse(
    await readFile(`${root}/packages/vela/package.json`, 'utf8'),
  )
  expect(pkg.name).toBe('@glows777/vela')
  expect(pkg.version).toBe(manifest.version)
  for (const [subpath, conditions] of Object.entries(pkg.exports) as [
    string,
    { types: string; import: string },
  ][]) {
    expect(subpath).not.toContain('*')
    expect(conditions.types).toMatch(/^\.\/dist\/.*\.d\.ts$/)
    expect(conditions.import).toMatch(/^\.\/dist\/.*\.js$/)
  }
  expect(
    await Bun.file(`${root}/packages/vela/api/public-api.txt`).exists(),
  ).toBe(true)
})

test('real source boundaries satisfy the permanent checker', async () => {
  const { checkBoundaries } = await import('../../scripts/check-boundaries.ts')
  expect(await checkBoundaries(root)).toEqual([])
})

test('packed README links the released tag, not main', async () => {
  const { releaseReadme } = await import('../../scripts/workspaces.ts')
  const text = await readFile(`${root}/packages/vela/README.md`, 'utf8')
  const packed = releaseReadme(text, '0.9.0-rc.1')
  expect(packed).not.toContain('/tree/main/')
  if (text.includes('/tree/main/'))
    expect(packed).toContain('github.com/glows777/Vela/tree/v0.9.0-rc.1/docs')
})
