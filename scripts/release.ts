/** One tag/version for all workspaces; resumable, dependency-ordered npm publication. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { $ } from 'bun'
import {
  nextVersion,
  releaseChangelog,
  UNRELEASED,
  unreleasedEntries,
} from './changelog.ts'
import {
  packWorkspaces,
  publishMissing,
  readWorkspaces,
  registryVersion,
} from './workspaces.ts'

const ROOT = resolve(import.meta.dir, '..')
const PACKAGE = join(ROOT, 'package.json')
const CHANGELOG = join(ROOT, 'CHANGELOG.md')
$.cwd(ROOT)
function fail(message: string): never {
  throw new Error(`release: ${message}`)
}
async function taggedRelease() {
  const packages = await readWorkspaces(ROOT)
  const root = JSON.parse(await readFile(PACKAGE, 'utf8'))
  const version = packages[0]!.version
  if (version !== root.version || process.env.TAG !== `v${version}`)
    fail('tag, root and package versions must match')
  const commit = (await $`git rev-parse HEAD`.quiet().text()).trim()
  const tagged = (
    await $`git rev-parse ${process.env.TAG + '^{commit}'}`.quiet().text()
  ).trim()
  if (commit !== tagged) fail('checkout is not the tagged release commit')
  return { packages, version, commit }
}
async function main() {
  const target = process.argv[2]
  if (target === '--status') {
    const { packages, version, commit } = await taggedRelease()
    const records = await Promise.all(
      packages.map((p) => registryVersion(p.name, p.version)),
    )
    for (let i = 0; i < records.length; i++)
      if (records[i] && records[i]!.gitHead !== commit)
        fail(
          `${packages[i]!.name} has a different or unverified published commit`,
        )
    console.log(`version=${version}`)
    console.log(`published=${records.every(Boolean)}`)
    return
  }
  if (target === '--publish') {
    const { commit, version } = await taggedRelease()
    const work = await mkdtemp(join(tmpdir(), 'vela-release-'))
    try {
      await $`bun run build`
      const packages = await packWorkspaces(ROOT, work)
      await publishMissing(packages, commit, {
        lookup: registryVersion,
        publish: async (pkg) => {
          console.log(`Publishing ${pkg.name}@${pkg.version}`)
          const tag = version.includes('-') ? 'next' : 'latest'
          await $`npm publish ${pkg.tarball} --provenance --access public --tag ${tag}`
        },
      })
      console.log('All six release packages are published and verified')
    } finally {
      await rm(work, { recursive: true, force: true })
    }
    return
  }
  if (!target)
    fail('Usage: bun run release <patch|minor|major|x.y.z|x.y.z-rc.N>')
  if ((await $`git status --porcelain`.text()).trim())
    fail('the working tree has uncommitted changes')
  if ((await $`git branch --show-current`.text()).trim() !== 'main')
    fail('releases are cut from main')
  await $`git fetch origin main --tags`
  if (
    (await $`git rev-parse HEAD`.text()) !==
    (await $`git rev-parse origin/main`.text())
  )
    fail('main is not in sync with origin/main')
  const pkgText = await readFile(PACKAGE, 'utf8')
  const current = JSON.parse(pkgText).version as string
  const packages = await readWorkspaces(ROOT)
  if (packages[0]!.version !== current)
    fail('root and package versions must match')
  const version = nextVersion(current, target)
  const tag = `v${version}`
  if ((await $`git tag --list ${tag}`.text()).trim())
    fail(`tag ${tag} already exists`)
  const changelog = await readFile(CHANGELOG, 'utf8')
  if (!unreleasedEntries(changelog))
    fail(`CHANGELOG.md has nothing under ${UNRELEASED}`)
  console.log(`Releasing ${current} -> ${version}`)
  await writeFile(
    PACKAGE,
    pkgText.replace(`"version": "${current}"`, `"version": "${version}"`),
  )
  for (const pkg of packages)
    await writeFile(
      join(pkg.dir, 'package.json'),
      JSON.stringify({ ...pkg.manifest, version }, null, 2) + '\n',
    )
  const released = releaseChangelog(
    changelog,
    version,
    new Date().toISOString().slice(0, 10),
  )
  if (released !== changelog) await writeFile(CHANGELOG, released)
  await $`bun install --lockfile-only --ignore-scripts`
  await $`bun run test`
  await $`bun run typecheck`
  await $`bun run lint`
  await $`bun run quality`
  await $`bun run smoke:consumer`
  const files = [
    'package.json',
    'bun.lock',
    ...packages.map((p) => join(p.dir, 'package.json')),
    ...(released !== changelog ? ['CHANGELOG.md'] : []),
  ]
  await $`git add ${files}`
  await $`git commit -m ${`Release ${tag}`}`
  await $`git tag -a ${tag} -m ${tag}`
  await $`git push --atomic origin main ${tag}`
  console.log(
    `Pushed ${tag}; Release publishes all six packages in dependency order`,
  )
}
if (import.meta.main) await main()
