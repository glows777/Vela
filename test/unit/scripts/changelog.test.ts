import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  nextVersion,
  releaseChangelog,
  releaseNotes,
  stampRelease,
  unreleasedEntries,
} from '../../../scripts/changelog.ts'

const CHANGELOG = `# Changelog

Intro with a [link](docs/sdk.md).

## [Unreleased]

### Fixed

- A fix, see [Sessions](docs/sessions.md#saving) and [pi](https://github.com/earendil-works/pi).

## [0.1.0] - 2026-10-09

First public release.
`

describe('changelog', () => {
  test('stamps release notes while keeping an empty [Unreleased] for local and tag CI', () => {
    const stamped = stampRelease(CHANGELOG, '0.1.1', '2026-10-10')
    expect(stamped).toContain('## [0.1.1] - 2026-10-10\n\n### Fixed')
    expect(unreleasedEntries(stamped)).toBe('')
    expect(stamped).toContain('## [Unreleased]\n\n## [0.1.1] - 2026-10-10')
    expect(releaseNotes(stamped, '0.1.1')).toContain('### Fixed')
    expect(() =>
      stampRelease(
        CHANGELOG.replace('## [Unreleased]', ''),
        '0.1.1',
        '2026-10-10',
      ),
    ).toThrow('no "## [Unreleased]" section')
  })

  test('reads the [Unreleased] entries and fails loudly without the section', () => {
    expect(unreleasedEntries(CHANGELOG)).toStartWith('### Fixed')
    const released = CHANGELOG.replace(
      '## [Unreleased]',
      '## [0.1.1] - 2026-10-10',
    )
    expect(() => unreleasedEntries(released)).toThrow(
      'no "## [Unreleased]" section',
    )
  })

  test('release notes are the version section with repo links pointing at the tag', () => {
    const stamped = stampRelease(CHANGELOG, '0.1.1', '2026-10-10')
    expect(releaseNotes(stamped, '0.1.1')).toBe(
      '### Fixed\n\n- A fix, see [Sessions](https://github.com/glows777/Vela/blob/v0.1.1/docs/sessions.md#saving) and [pi](https://github.com/earendil-works/pi).',
    )
    expect(releaseNotes(stamped, '0.1.0')).toBe('First public release.')
    expect(() => releaseNotes(stamped, '0.2.0')).toThrow('no entries for 0.2.0')
  })

  test('the repo changelog has release notes for the published version', async () => {
    const root = join(import.meta.dir, '../../..')
    const changelog = await Bun.file(join(root, 'CHANGELOG.md')).text()
    const { version } = await Bun.file(join(root, 'package.json')).json()
    expect(releaseNotes(changelog, version)).toContain('###')
    unreleasedEntries(changelog)
  })

  test('next version', () => {
    expect(nextVersion('0.1.0', 'patch')).toBe('0.1.1')
    expect(nextVersion('0.1.3', 'minor')).toBe('0.2.0')
    expect(nextVersion('0.1.3', 'major')).toBe('1.0.0')
    expect(nextVersion('0.1.3', '0.1.10')).toBe('0.1.10')
    expect(() => nextVersion('0.1.3', '0.1.3')).toThrow('not newer')
    expect(() => nextVersion('0.1.3', '0.0.9')).toThrow('not newer')
    expect(() => nextVersion('0.1.3', 'next')).toThrow('Not a version')
  })

  test('an explicit release candidate sorts by triple, then final, then counter', () => {
    expect(nextVersion('0.3.0', '0.4.0-rc.1')).toBe('0.4.0-rc.1')
    expect(nextVersion('0.4.0-rc.1', '0.4.0-rc.2')).toBe('0.4.0-rc.2')
    expect(nextVersion('0.4.0-rc.2', '0.4.0-rc.10')).toBe('0.4.0-rc.10')
    expect(nextVersion('0.4.0-rc.2', '0.4.0')).toBe('0.4.0')
    expect(nextVersion('0.4.0-rc.9', '0.4.1-rc.1')).toBe('0.4.1-rc.1')
    expect(() => nextVersion('0.4.0', '0.4.0-rc.1')).toThrow('not newer')
    expect(() => nextVersion('0.4.0-rc.2', '0.4.0-rc.1')).toThrow('not newer')
    expect(() => nextVersion('0.4.0-rc.1', '0.4.0-rc.1')).toThrow('not newer')
    expect(() => nextVersion('0.4.0-rc.1', 'patch')).toThrow('explicit version')
    expect(() => nextVersion('0.4.0-rc.1', 'minor')).toThrow('explicit version')
    expect(() => nextVersion('0.4.0-rc.1', 'major')).toThrow('explicit version')
    expect(() => nextVersion('0.3.0', '0.4.0-alpha.1')).toThrow('Not a version')
    expect(() => nextVersion('0.3.0', '0.4.0-beta.1')).toThrow('Not a version')
    expect(() => nextVersion('0.3.0', '0.4.0-rc')).toThrow('Not a version')
  })

  test('a release candidate leaves the changelog text unchanged', () => {
    expect(releaseChangelog(CHANGELOG, '0.4.0-rc.1', '2026-10-26')).toBe(
      CHANGELOG,
    )
    expect(releaseChangelog(CHANGELOG, '0.4.0', '2026-10-26')).toContain(
      '## [Unreleased]\n\n## [0.4.0] - 2026-10-26',
    )
  })

  test('release notes for a release candidate are the Unreleased entries', () => {
    expect(releaseNotes(CHANGELOG, '0.4.0-rc.1')).toBe(
      '### Fixed\n\n- A fix, see [Sessions](https://github.com/glows777/Vela/blob/v0.4.0-rc.1/docs/sessions.md#saving) and [pi](https://github.com/earendil-works/pi).',
    )
  })

  test('a candidate retry reads the tag snapshot, not main after it advances', async () => {
    const tagSnapshot = `# Changelog

## [Unreleased]

### Added

- Original candidate entry.

## [0.3.0] - 2026-10-01

Previous.
`
    const mainAfterFinal = stampRelease(tagSnapshot, '0.4.0', '2026-10-26')
    const root = join(import.meta.dir, '../../..')
    const workflow = await Bun.file(
      join(root, '.github/workflows/release.yml'),
    ).text()
    const jobStart = workflow.indexOf('\n  github-release:')
    const job = workflow.slice(jobStart)
    const checkout = job
      .slice(job.indexOf('actions/checkout'), job.indexOf('oven-sh/setup-bun'))
      .replace(/#[^\n]*/g, '')
    const readsTag = /ref:\s*refs\/tags\/\$\{\{\s*env\.TAG\s*\}\}/.test(checkout)
    const changelog = readsTag ? tagSnapshot : mainAfterFinal
    expect(releaseNotes(changelog, '0.4.0-rc.1')).toBe(
      '### Added\n\n- Original candidate entry.',
    )
  })
})
