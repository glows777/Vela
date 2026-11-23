import { expect, test } from 'bun:test'
import { join } from 'node:path'
import type { createVela } from '@glows777/vela'
import type { LoadedChannelExtension } from '../../packages/vela/src/legacy-channels/index.ts'
import { stampRelease, unreleasedEntries } from '../../scripts/changelog.ts'

type Extensions = ReturnType<ReturnType<typeof createVela>['extensions']>
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

const publishedMigrationMatchesExtensions: Same<
  Extensions,
  LoadedChannelExtension[]
> = true

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

test('removed umbrella LoadedExtension migration matches extensions()', async () => {
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
    expect(bullet).toContain('returns `LoadedChannelExtension[]`')
  }
  expect(publishedMigrationMatchesExtensions).toBe(true)
})
