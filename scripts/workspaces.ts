/** Shared workspace build/pack/release inventory. These are development tools, never SDK exports. */
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { $ } from 'bun'

export const WORKSPACE_ORDER = [
  'core',
  'channels',
  'mcp',
  'rag',
  'lark',
  'vela',
] as const
export interface ReleasePackage {
  key: string
  name: string
  version: string
  dependencies?: Record<string, string | undefined>
}
export interface WorkspacePackage extends ReleasePackage {
  dir: string
  manifest: Record<string, unknown>
}
export async function readWorkspaces(
  root = resolve(import.meta.dir, '..'),
): Promise<WorkspacePackage[]> {
  const packages: WorkspacePackage[] = []
  for (const key of WORKSPACE_ORDER) {
    const dir = join(root, 'packages', key)
    const manifest = JSON.parse(
      await readFile(join(dir, 'package.json'), 'utf8'),
    )
    packages.push({
      key,
      dir,
      manifest,
      name: manifest.name,
      version: manifest.version,
      dependencies: manifest.dependencies,
    })
  }
  if (new Set(packages.map((p) => p.version)).size !== 1)
    throw new Error('workspace versions must remain lockstep')
  return packages
}
export async function packWorkspaces(root: string, work: string) {
  const packages = await readWorkspaces(root)
  const known = new Map(packages.map((p) => [p.name, p.version]))
  const packed = []
  const commit = (await $`git rev-parse HEAD`.cwd(root).quiet().text()).trim()
  const packDir = join(work, 'pack')
  await mkdir(packDir, { recursive: true })
  for (const pkg of packages) {
    const dir = join(work, 'stage', pkg.key)
    await mkdir(dir, { recursive: true })
    const manifest = structuredClone(pkg.manifest)
    for (const field of [
      'dependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      const dependencies = manifest[field] as Record<string, string> | undefined
      for (const [name, value] of Object.entries(dependencies ?? {}))
        if (value.startsWith('workspace:')) {
          const version = known.get(name)
          if (!version) throw new Error(`unknown workspace ${name}`)
          dependencies![name] = version
        }
    }
    manifest.gitHead = commit
    for (const file of manifest.files as string[]) {
      try {
        await cp(join(pkg.dir, file), join(dir, file), { recursive: true })
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT' &&
            !['dist', 'LICENSE', 'README.md'].includes(file)
          )
        )
          throw error
      }
    }
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify(manifest, null, 2) + '\n',
    )
    await $`bun pm pack --destination ${packDir} --quiet`.cwd(dir)
    const tarball = join(
      packDir,
      `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`,
    )
    const contents = await $`tar -tzf ${tarball}`.quiet().text()
    if (contents.includes('package/src/') || contents.includes('package/test/'))
      throw new Error(`${pkg.name} ships source or tests`)
    for (const file of [
      'package/LICENSE',
      'package/README.md',
      'package/dist/index.js',
      'package/dist/index.d.ts',
    ])
      if (!contents.includes(file))
        throw new Error(`${pkg.name} missing ${file}`)
    const actual = JSON.parse(
      await $`tar -xOf ${tarball} package/package.json`.quiet().text(),
    )
    for (const field of [
      'dependencies',
      'peerDependencies',
      'optionalDependencies',
    ])
      for (const [name, value] of Object.entries(actual[field] ?? {}))
        if (known.has(name) && value !== known.get(name))
          throw new Error(
            `${pkg.name} has invalid packed dependency ${name}: ${value}`,
          )
    const integrity =
      'sha512-' +
      createHash('sha512')
        .update(await readFile(tarball))
        .digest('base64')
    packed.push({ ...pkg, manifest: actual, tarball, integrity })
  }
  return packed
}
interface RegistryVersion {
  gitHead?: string
}
export async function registryVersion(
  name: string,
  version: string,
  registry = 'https://registry.npmjs.org',
): Promise<RegistryVersion | undefined> {
  const response = await fetch(
    `${registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
  )
  if (response.status === 404) return undefined
  if (!response.ok)
    throw new Error(
      `registry lookup ${name}@${version} failed: HTTP ${response.status}`,
    )
  return response.json() as Promise<RegistryVersion>
}
export async function publishMissing<T extends ReleasePackage>(
  packages: T[],
  commit: string,
  io: {
    lookup(name: string, version: string): Promise<RegistryVersion | undefined>
    publish(pkg: T): Promise<void>
  },
): Promise<void> {
  const known = new Set(packages.map((p) => p.name))
  const same = (pkg: ReleasePackage, record: RegistryVersion) => {
    if (record.gitHead !== commit)
      throw new Error(
        `${pkg.name}@${pkg.version} belongs to a different or unverified release commit`,
      )
  }
  for (const pkg of packages) {
    const existing = await io.lookup(pkg.name, pkg.version)
    if (existing) {
      same(pkg, existing)
      continue
    }
    for (const name of Object.keys(pkg.dependencies ?? {}))
      if (known.has(name)) {
        const record = await io.lookup(name, pkg.version)
        if (!record)
          throw new Error(
            `required dependency ${name}@${pkg.version} is not published`,
          )
        same({ key: name, name, version: pkg.version }, record)
      }
    await io.publish(pkg)
    const published = await io.lookup(pkg.name, pkg.version)
    if (!published)
      throw new Error(
        `${pkg.name}@${pkg.version} is not visible after publishing`,
      )
    same(pkg, published)
  }
}
