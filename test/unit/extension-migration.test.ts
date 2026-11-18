import { expect, test } from 'bun:test'
import { join } from 'node:path'
import type { createVela } from '@glows777/vela'
import type { LoadedChannelExtension } from '@glows777/vela-channels'

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

test('removed umbrella LoadedExtension migration matches extensions()', async () => {
  const changelog = await Bun.file(
    join(import.meta.dir, '../../CHANGELOG.md'),
  ).text()
  const unreleased = changelog.split(/^## \[/m)[1]
  const breaking = unreleased
    ?.split(/^### /m)
    .find((part) => part.startsWith('Breaking Changes'))
  const bullet = breaking
    ?.split('\n- ')
    .find((part) => part.includes("unused alias of the channel package's"))
  if (bullet === undefined)
    throw new Error('missing the removed LoadedExtension breaking bullet')
  expect(migrationImports(bullet)).toEqual([
    {
      name: 'LoadedChannelExtension',
      from: '@glows777/vela-channels',
    },
  ])
  expect(publishedMigrationMatchesExtensions).toBe(true)
})
