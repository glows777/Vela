/** Build real workspace artifacts in dependency order; public imports resolve through export maps. */
import { chmod, cp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { $ } from 'bun'

const root = resolve(import.meta.dir, '..')

export async function copyPackageAssets(
  root: string,
  dir: string,
  umbrella: boolean,
) {
  for (const file of ['LICENSE', 'CHANGELOG.md'])
    await cp(join(root, file), join(dir, file))
  if (umbrella)
    for (const folder of ['docs', 'examples']) {
      await rm(join(dir, folder), { recursive: true, force: true })
      await cp(join(root, folder), join(dir, folder), { recursive: true })
    }
}

if (import.meta.main)
  for (const name of ['core', 'channels', 'mcp', 'rag', 'lark', 'vela']) {
    const dir = join(root, 'packages', name)
    await rm(join(dir, 'dist'), { recursive: true, force: true })
    await $`bunx --no-install tsc -p ${join(dir, 'tsconfig.build.json')}`.cwd(
      root,
    )
    await copyPackageAssets(root, dir, name === 'vela')
    if (name === 'vela') {
      await chmod(join(dir, 'dist/cli/main.js'), 0o755)
    }
  }
