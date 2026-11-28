import { expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkDocsConsistency } from '../../scripts/check-docs-consistency.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')

test('#591 / #599 / #602: checkDocsConsistency passes cleanly on the repository root', async () => {
  expect(await checkDocsConsistency(REPO_ROOT)).toEqual([])
})

test('#591 / #599 / #602: checkDocsConsistency catches retired APIs, operational leftovers, legacy claims, undocumented options, and missing changelog coverage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vela-docs-check-'))
  try {
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'examples/sdk'), { recursive: true })
    mkdirSync(join(root, 'packages/vela/api'), { recursive: true })
    cpSync(
      join(REPO_ROOT, 'packages/vela/api/public-api.txt'),
      join(root, 'packages/vela/api/public-api.txt'),
    )
    writeFileSync(
      join(root, 'docs/sdk.md'),
      [
        '## createRuntime options',
        '',
        '| Option | Default | Description |',
        '|---|---|---|',
        '| `nonExistentOption` | none | Fake option |',
        '',
        'Uses `@glows777/vela-core` and `sessionStorage`.',
        'Run `createVela({ model })` and `lark({ appId })` in app code.',
      ].join('\n'),
    )
    writeFileSync(
      join(root, 'docs/channels.md'),
      'Start the gateway with `vela serve` or `--mode rpc`.\n',
    )
    writeFileSync(
      join(root, 'examples/sdk/demo.ts'),
      "import { createVela } from '@glows777/vela'\nconst v = createVela({})\n",
    )
    writeFileSync(
      join(root, 'docs/settings.md'),
      'Store in ~/.vela/vela.db with no container format doc.',
    )
    writeFileSync(
      join(root, 'docs/upgrading.md'),
      'A pre-existing .dream/ directory is imported automatically.\n`trusted_paths` is stored in `<dataDir>/vela.db`?',
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
    expect(joined).toContain(
      'public CreateRuntimeOptions property "agentDir" is missing',
    )
    expect(joined).toContain('trusted_paths')
    expect(joined).toContain('rather than <dataDir>/vela.db')
    expect(joined).toContain('env:<encodedOwnerDataDir>')
    expect(joined).toContain('env:<encodedName>:<posixCwd>')
    expect(joined).toContain('createRuntime({ agentDir })')
    expect(joined).toContain('retired "vela serve"')
    expect(joined).toContain('retired "--mode rpc"')
    expect(joined).toContain('retired "createVela("')
    expect(joined).toContain('retired "lark() factory"')
    expect(joined).toContain('examples/sdk/demo.ts:2')

    // Explicit retirement/migration notices stay allowed (#599/#602)
    writeFileSync(
      join(root, 'docs/channels.md'),
      '`vela serve` and `--mode rpc` were retired in v0.9 and exit with code 2; use `vela daemon` and `connectRuntime()` instead.\n',
    )
    writeFileSync(
      join(root, 'examples/sdk/demo.ts'),
      'import { createRuntime } from "@glows777/vela"\nvoid createRuntime\n',
    )
    const afterRetirementNotice = (await checkDocsConsistency(root)).join('\n')
    expect(afterRetirementNotice).not.toContain('docs/channels.md')
    expect(afterRetirementNotice).not.toContain('examples/sdk/demo.ts')

    // Standalone "legacy" word inside @glows777/vela/legacy-desktop must not self-exempt a bare import
    writeFileSync(
      join(root, 'examples/sdk/demo.ts'),
      'import "@glows777/vela/legacy-desktop"\n',
    )
    expect((await checkDocsConsistency(root)).join('\n')).toContain(
      'examples/sdk/demo.ts:1: contains non-retirement operational reference to retired "@glows777/vela/legacy-desktop"',
    )
    writeFileSync(
      join(root, 'examples/sdk/demo.ts'),
      'import { createRuntime } from "@glows777/vela"\nvoid createRuntime\n',
    )

    // Verify missing env:<encodedName>:<posixCwd> is caught even when env:<encodedOwnerDataDir>:<encodedName>:<posixCwd> is present
    writeFileSync(
      join(root, 'docs/settings.md'),
      '$VELA_DIR/vela.db `env:<encodedOwnerDataDir>:<encodedName>:<posixCwd>`',
    )
    writeFileSync(
      join(root, 'docs/upgrading.md'),
      '`trusted_paths` in `$VELA_DIR/vela.db` (`env:<encodedOwnerDataDir>:<encodedName>:<posixCwd>`)\n`createRuntime({ agentDir })` `<agentDir>/vela.db`',
    )
    const missingUnscoped = (await checkDocsConsistency(root)).join('\n')
    expect(missingUnscoped).toContain(
      'docs/settings.md: must document both container trust key formats',
    )
    expect(missingUnscoped).toContain(
      'docs/upgrading.md: trusted_paths entry must document',
    )

    // #593: verify createRuntime() hostEnv default checks between runtime-sdk.ts, docs/sdk.md, and CHANGELOG.md
    mkdirSync(join(root, 'packages/vela/src'), { recursive: true })
    writeFileSync(
      join(root, 'packages/vela/src/runtime-sdk.ts'),
      'const hostEnv = options.hostEnv ?? {}\n',
    )
    writeFileSync(
      join(root, 'CHANGELOG.md'),
      '## [Unreleased]\n\n- `createRuntime()` now defaults `hostEnv` to `process.env` ($VELA_DIR/vela.db fallback createRuntime({ agentDir }) `<agentDir>/vela.db`).\n',
    )
    const hostEnvMismatch = (await checkDocsConsistency(root)).join('\n')
    expect(hostEnvMismatch).toContain(
      'CHANGELOG.md [Unreleased]: falsely claims createRuntime() defaults hostEnv to process.env',
    )
    expect(hostEnvMismatch).toContain(
      'docs/sdk.md: must document that createRuntime() hostEnv defaults to {} (#593)',
    )
    expect(hostEnvMismatch).toContain(
      'CHANGELOG.md [Unreleased]: must agree with docs/sdk.md and runtime-sdk.ts that createRuntime() hostEnv defaults to {} (#593)',
    )

    // Contradictory "inherits process.env" wording must still be rejected even alongside the "{}" sentence
    writeFileSync(
      join(root, 'CHANGELOG.md'),
      '## [Unreleased]\n\n- `createRuntime()` keeps `hostEnv` defaulting to `{}`. Note: `createRuntime()` inherits `process.env` when `hostEnv` is omitted ($VELA_DIR/vela.db fallback createRuntime({ agentDir }) `<agentDir>/vela.db`).\n',
    )
    expect((await checkDocsConsistency(root)).join('\n')).toContain(
      'CHANGELOG.md [Unreleased]: falsely claims createRuntime() defaults hostEnv to process.env',
    )

    // When docs/sdk.md states the default and CHANGELOG.md [Unreleased] does not mention hostEnv, neither #593 error fires
    writeFileSync(
      join(root, 'docs/sdk.md'),
      '$VELA_DIR/vela.db\n`hostEnv` defaults to `{}`\n',
    )
    writeFileSync(
      join(root, 'CHANGELOG.md'),
      '## [Unreleased]\n\n$VELA_DIR/vela.db fallback createRuntime({ agentDir }) `<agentDir>/vela.db`\n',
    )
    const noHostEnvErrors = (await checkDocsConsistency(root)).join('\n')
    expect(noHostEnvErrors).not.toContain('#593')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
