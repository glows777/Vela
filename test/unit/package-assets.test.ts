import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('rebuilding package assets removes deleted documentation and examples', async () => {
  const { copyPackageAssets } = await import('../../scripts/build.ts')
  const root = await mkdtemp(join(tmpdir(), 'vela-assets-'))
  const pkg = join(root, 'packages/vela')
  try {
    await mkdir(pkg, { recursive: true })
    for (const file of ['LICENSE', 'CHANGELOG.md'])
      await writeFile(join(root, file), file)
    for (const folder of ['docs', 'examples']) {
      await mkdir(join(root, folder))
      await writeFile(join(root, folder, 'old.txt'), 'obsolete')
    }
    await copyPackageAssets(root, pkg, true)
    for (const folder of ['docs', 'examples']) {
      await rm(join(root, folder, 'old.txt'))
      await writeFile(join(root, folder, 'current.txt'), 'current')
    }
    await copyPackageAssets(root, pkg, true)
    for (const folder of ['docs', 'examples']) {
      expect(await Bun.file(join(pkg, folder, 'old.txt')).exists()).toBe(false)
      expect(await readFile(join(pkg, folder, 'current.txt'), 'utf8')).toBe(
        'current',
      )
    }
    expect(await readFile(join(pkg, 'LICENSE'), 'utf8')).toBe('LICENSE')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
