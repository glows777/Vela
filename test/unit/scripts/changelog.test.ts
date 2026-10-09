import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  addUnreleased,
  nextVersion,
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
  test('stamps [Unreleased] as the release and adds a fresh [Unreleased] above it', () => {
    const stamped = stampRelease(CHANGELOG, '0.1.1', '2026-10-10')
    expect(stamped).toContain('## [0.1.1] - 2026-10-10\n\n### Fixed')
    expect(stamped).not.toContain('[Unreleased]')
    expect(unreleasedEntries(addUnreleased(stamped))).toBe('')
    expect(addUnreleased(stamped)).toContain(
      '## [Unreleased]\n\n## [0.1.1] - 2026-10-10',
    )
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
})
