import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { stampRelease, unreleasedEntries } from '../../scripts/changelog.ts'

function migrationImports(bullet: string): { name: string; from: string }[] {
  return [
    ...bullet.matchAll(/`([A-Za-z0-9]+)` from `(@glows777\/vela[^`]*)`/g),
  ].map((match) => ({
    name: match[1] ?? '',
    from: match[2] ?? '',
  }))
}

function removedAliasBullet(changelog: string): string {
  const bullet = changelog
    .split('\n- ')
    .find((part) => part.includes("unused alias of the channel package's"))
  if (bullet === undefined)
    throw new Error('missing the removed LoadedExtension breaking bullet')
  return bullet
}

test('CHANGELOG release stamping preserves breaking migration bullets', async () => {
  const changelog = await Bun.file(
    join(import.meta.dir, '../../CHANGELOG.md'),
  ).text()
  const stamped = stampRelease(changelog, '9.9.9', '2026-01-01')
  expect(unreleasedEntries(stamped)).toBe('')
  for (const text of [changelog, stamped]) {
    const bullet = removedAliasBullet(text)
    expect(migrationImports(bullet)).toEqual([
      {
        name: 'LoadedChannelExtension',
        from: '@glows777/vela-channels',
      },
    ])
  }
})
