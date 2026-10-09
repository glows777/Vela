/**
 * CHANGELOG.md helpers shared by the release script and the release workflow.
 * Run directly to print a version's release notes, as the release workflow does:
 *   bun scripts/changelog.ts notes <version>
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const UNRELEASED = '## [Unreleased]'
const REPO_URL = 'https://github.com/glows777/Vela'

/** Body of the section under `heading` (up to the next `## [` heading), or undefined if there is no such heading. */
function sectionBody(changelog: string, heading: string): string | undefined {
  const lines = changelog.split('\n')
  const start = lines.findIndex(
    (line) => line.trimEnd() === heading || line.startsWith(`${heading} `),
  )
  if (start === -1) return undefined
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## ['))
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim()
}

/** Entries under `## [Unreleased]`; throws if the section is missing. */
export function unreleasedEntries(changelog: string): string {
  const body = sectionBody(changelog, UNRELEASED)
  if (body === undefined)
    throw new Error(`CHANGELOG.md has no "${UNRELEASED}" section`)
  return body
}

/** Turns `## [Unreleased]` into `## [version] - date`. */
export function stampRelease(
  changelog: string,
  version: string,
  date: string,
): string {
  unreleasedEntries(changelog)
  return changelog.replace(UNRELEASED, `## [${version}] - ${date}`)
}

/** Adds an empty `## [Unreleased]` section above the newest release. */
export function addUnreleased(changelog: string): string {
  const at = changelog.indexOf('\n## [')
  if (at === -1) throw new Error('CHANGELOG.md has no release sections')
  return `${changelog.slice(0, at + 1)}${UNRELEASED}\n\n${changelog.slice(at + 1)}`
}

/**
 * The GitHub release notes for `version`: its CHANGELOG section, with links to repo files
 * pointing at the tag on GitHub (relative links don't resolve on a release page).
 */
export function releaseNotes(changelog: string, version: string): string {
  const body = sectionBody(changelog, `## [${version}]`)
  if (!body) throw new Error(`CHANGELOG.md has no entries for ${version}`)
  return body.replace(
    /\]\((?![a-z][a-z0-9+.-]*:|#)([^)\s]+)\)/gi,
    (_, path: string) =>
      `](${REPO_URL}/blob/v${version}/${path.replace(/^\.?\//, '')})`,
  )
}

/** `current` bumped by `patch`, `minor` or `major`, or an explicit `x.y.z` that must be newer. */
export function nextVersion(current: string, target: string): string {
  const parse = (v: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
    if (!match) throw new Error(`Not a version: ${v}`)
    return match.slice(1).map(Number) as [number, number, number]
  }
  const [major, minor, patch] = parse(current)
  if (target === 'major') return `${major + 1}.0.0`
  if (target === 'minor') return `${major}.${minor + 1}.0`
  if (target === 'patch') return `${major}.${minor}.${patch + 1}`
  const next = parse(target)
  const cur = [major, minor, patch]
  const diff = next.map((n, i) => n - (cur[i] ?? 0)).find((d) => d !== 0) ?? 0
  if (diff <= 0) throw new Error(`${target} is not newer than ${current}`)
  return target
}

if (import.meta.main) {
  const [command, version] = process.argv.slice(2)
  if (command !== 'notes' || !version) {
    console.error('Usage: bun scripts/changelog.ts notes <version>')
    process.exit(1)
  }
  const root = resolve(import.meta.dir, '..')
  process.stdout.write(
    `${releaseNotes(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), version)}\n`,
  )
}
