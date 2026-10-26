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

type Version = {
  major: number
  minor: number
  patch: number
  rc: number | null
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/

function parseVersion(input: string): Version | undefined {
  const match = VERSION.exec(input)
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    rc: match[4] === undefined ? null : Number(match[4]),
  }
}

function requireVersion(input: string): Version {
  const version = parseVersion(input)
  if (!version) throw new Error(`Not a version: ${input}`)
  return version
}

function compareVersions(left: Version, right: Version): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  if (left.patch !== right.patch) return left.patch - right.patch
  if (left.rc === right.rc) return 0
  if (left.rc === null) return 1
  if (right.rc === null) return -1
  return left.rc - right.rc
}

/** Moves unreleased entries into a release, keeping an empty section for the next one. */
export function stampRelease(
  changelog: string,
  version: string,
  date: string,
): string {
  unreleasedEntries(changelog)
  return changelog.replace(
    UNRELEASED,
    `${UNRELEASED}\n\n## [${version}] - ${date}`,
  )
}

export function releaseChangelog(
  changelog: string,
  version: string,
  date: string,
): string {
  if (requireVersion(version).rc !== null) return changelog
  return stampRelease(changelog, version, date)
}

/** Relative links in release notes do not resolve on a GitHub release page. */
export function releaseNotes(changelog: string, version: string): string {
  const parsed = parseVersion(version)
  const body =
    parsed !== undefined && parsed.rc !== null
      ? unreleasedEntries(changelog)
      : sectionBody(changelog, `## [${version}]`)
  if (!body) throw new Error(`CHANGELOG.md has no entries for ${version}`)
  return body.replace(
    /\]\((?![a-z][a-z0-9+.-]*:|#)([^)\s]+)\)/gi,
    (_, path: string) =>
      `](${REPO_URL}/blob/v${version}/${path.replace(/^\.?\//, '')})`,
  )
}

export function nextVersion(current: string, target: string): string {
  const parsed = requireVersion(current)
  if (target === 'major' || target === 'minor' || target === 'patch') {
    if (parsed.rc !== null)
      throw new Error(
        `${current} is a release candidate; pass an explicit version`,
      )
    if (target === 'major') return `${parsed.major + 1}.0.0`
    if (target === 'minor') return `${parsed.major}.${parsed.minor + 1}.0`
    return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
  }
  const next = requireVersion(target)
  if (compareVersions(next, parsed) <= 0)
    throw new Error(`${target} is not newer than ${current}`)
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
