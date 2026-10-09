/**
 * Cuts a release, like pi's scripts/release.mjs:
 *   bun run release <patch|minor|major|x.y.z>
 *
 * 1. Checks the working tree is clean, on main and up to date with origin/main
 * 2. Checks CHANGELOG.md has entries under ## [Unreleased]
 * 3. Sets the version in package.json and turns ## [Unreleased] into ## [x.y.z] - date
 * 4. Runs the same checks as CI
 * 5. Commits "Release vx.y.z" and tags it vx.y.z
 * 6. Adds an empty ## [Unreleased] section and commits it
 * 7. Pushes main and the tag; the tag starts .github/workflows/release.yml, which
 *    publishes to npm and creates the GitHub release
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { $ } from 'bun'
import {
  addUnreleased,
  nextVersion,
  stampRelease,
  UNRELEASED,
  unreleasedEntries,
} from './changelog.ts'

const ROOT = resolve(import.meta.dir, '..')
const PACKAGE = join(ROOT, 'package.json')
const CHANGELOG = join(ROOT, 'CHANGELOG.md')
$.cwd(ROOT)

const target = process.argv[2]
if (!target) {
  console.error('Usage: bun run release <patch|minor|major|x.y.z>')
  process.exit(1)
}

function fail(message: string): never {
  console.error(`release: ${message}`)
  process.exit(1)
}

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
const current: string = JSON.parse(pkgText).version
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
const date = new Date().toISOString().slice(0, 10)
await writeFile(CHANGELOG, stampRelease(changelog, version, date))

await $`bun run test`
await $`bun run typecheck`
await $`bun run lint`
await $`bun run smoke:consumer`

await $`git add package.json CHANGELOG.md`
await $`git commit -m ${`Release ${tag}`}`
await $`git tag -a ${tag} -m ${tag}`

await writeFile(CHANGELOG, addUnreleased(await readFile(CHANGELOG, 'utf8')))
await $`git add CHANGELOG.md`
await $`git commit -m ${'Add [Unreleased] section for the next release'}`

await $`git push --atomic origin main ${tag}`
console.log(
  `Pushed ${tag}; the Release workflow publishes it to npm and GitHub.`,
)
