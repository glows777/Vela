import { expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkDocsConsistency } from '../../scripts/check-docs-consistency.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')

test('#591: checkDocsConsistency passes cleanly on the repository root', async () => {
  expect(await checkDocsConsistency(REPO_ROOT)).toEqual([])
})

test('#591: checkDocsConsistency catches retired APIs, legacy migration claims, undocumented options, and missing changelog coverage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vela-docs-check-'))
  try {
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'packages/vela/api'), { recursive: true })
    cpSync(
      join(REPO_ROOT, 'packages/vela/api/public-api.txt'),
      join(root, 'packages/vela/api/public-api.txt'),
    )
    writeFileSync(
      join(root, 'docs/sdk.md'),
      [
        '## createVela options',
        '',
        '| Option | Purpose |',
        '|---|---|',
        '| `nonExistentOption` | Fake option |',
        '',
        'Uses `@glows777/vela-core` and `sessionStorage`.',
      ].join('\n'),
    )
    writeFileSync(
      join(root, 'docs/settings.md'),
      'Store in ~/.vela/vela.db with no container format doc.',
    )
    writeFileSync(
      join(root, 'docs/upgrading.md'),
      'A pre-existing .dream/ directory is imported automatically.',
    )
    writeFileSync(join(root, 'docs/sessions.md'), 'No DB note here.')
    writeFileSync(
      join(root, 'CHANGELOG.md'),
      '## [Unreleased]\n\n- Nothing yet.\n',
    )

    const errors = await checkDocsConsistency(root)
    const joined = errors.join('\n')
    expect(joined).toContain('sessionStorage')
    expect(joined).toContain('@glows777\\/vela-')
    expect(joined).toContain('pre-existing')
    expect(joined).toContain('nonExistentOption')
    expect(joined).toContain('trusted_paths')
    expect(joined).toContain('env:<encodedOwnerDataDir>')
    expect(joined).toContain('createVela({ dataDir })')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
