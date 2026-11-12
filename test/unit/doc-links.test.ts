import { expect, test } from 'bun:test'
import { anchors, brokenLinks } from '../../scripts/check-doc-links.ts'

const files: Record<string, string> = {
  '/repo/docs/b.md':
    '# Title\n\n## Event lines ([cli](cli.md))\n\n<a id="pinned"></a>\n',
}
const read = (path: string) => files[path]

test('heading anchors follow GitHub slugs and keep explicit ids', () => {
  expect([...anchors(files['/repo/docs/b.md']!)]).toEqual([
    'title',
    'event-lines-cli',
    'pinned',
  ])
})

test('a link to a missing file or heading is reported; code fences and URLs are not', () => {
  const markdown = [
    '[ok](b.md#event-lines-cli) [id](b.md#pinned) [web](https://example.com/x)',
    '[gone](missing.md) [stale](b.md#event-lines)',
    '```',
    '[example](nowhere.md)',
    '```',
  ].join('\n')
  expect(brokenLinks('/repo/docs/a.md', markdown, read)).toEqual([
    'missing.md: no such file',
    'b.md#event-lines: no such heading',
  ])
})
