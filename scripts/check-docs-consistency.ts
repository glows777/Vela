import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { Glob } from 'bun'

const RETIRED_IDENTIFIERS = [
  /\bsessionStorage\b/,
  /\bSessionStorage\b/,
  /\bfileSessionStorage\b/,
  /\bmemorySessionStorage\b/,
  /@glows777\/vela-(?:core|channels|lark|mcp|rag)\b/,
  /packages\/(?:core|channels)\//,
] as const

const RETIRED_BEHAVIOR_CLAIMS = [
  /pre-existing [`']?\.dream\/[`']? directory is imported/i,
  /one-time read-only [`']?\.dream\/[`']? import/i,
  /automatically flattened into ~\/\.vela\/config\.json/i,
] as const

function extractInterfaceKeys(
  publicApi: string,
  interfaceName: string,
): Set<string> {
  const keys = new Set<string>()
  const marker = `  interface ${interfaceName}\n`
  const start = publicApi.indexOf(marker)
  if (start === -1) return keys
  const rest = publicApi.slice(start + marker.length)
  for (const line of rest.split('\n')) {
    if (!line.startsWith('    ')) break
    const match = /^\s{4}([A-Za-z0-9_]+)\??:/.exec(line)
    if (match?.[1]) keys.add(match[1])
  }
  return keys
}

function extractSdkTableOptions(sdkDoc: string): string[] {
  const sectionMarker = '## createVela options\n'
  const start = sdkDoc.indexOf(sectionMarker)
  if (start === -1) return []
  const nextHeading = sdkDoc.indexOf('\n## ', start + sectionMarker.length)
  const section =
    nextHeading === -1 ? sdkDoc.slice(start) : sdkDoc.slice(start, nextHeading)
  const options: string[] = []
  for (const line of section.split('\n')) {
    if (!line.startsWith('| `')) continue
    const match = /^\|\s*`([^`]+)`\s*\|/.exec(line)
    if (match?.[1]) options.push(match[1])
  }
  return options
}

function extractUnreleasedSection(changelog: string): string {
  const start = changelog.indexOf('## [Unreleased]')
  if (start === -1) return ''
  const nextRelease = changelog.indexOf('\n## [', start + 15)
  return nextRelease === -1
    ? changelog.slice(start)
    : changelog.slice(start, nextRelease)
}

/**
 * Enforces documentation consistency (#576, #581, #583, #591) against `public-api.txt`
 * and current SQLite / config / packaging contracts.
 */
export async function checkDocsConsistency(root: string): Promise<string[]> {
  const errors: string[] = []

  const docFiles: string[] = []
  for await (const rel of new Glob('docs/**/*.md').scan(root)) {
    docFiles.push(join(root, rel))
  }
  docFiles.sort()

  for (const file of docFiles) {
    const rel = relative(root, file).replaceAll('\\', '/')
    const text = await readFile(file, 'utf8')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      for (const pattern of RETIRED_IDENTIFIERS) {
        if (pattern.test(line)) {
          errors.push(
            `${rel}:${i + 1}: references retired API or package matching ${pattern.source}`,
          )
        }
      }
      for (const pattern of RETIRED_BEHAVIOR_CLAIMS) {
        if (pattern.test(line)) {
          errors.push(
            `${rel}:${i + 1}: claims removed automatic legacy migration (${pattern.source})`,
          )
        }
      }
    }
  }

  const publicApiPath = join(root, 'packages/vela/api/public-api.txt')
  const sdkDocPath = join(root, 'docs/sdk.md')
  if (existsSync(publicApiPath) && existsSync(sdkDocPath)) {
    const [publicApi, sdkDoc] = await Promise.all([
      readFile(publicApiPath, 'utf8'),
      readFile(sdkDocPath, 'utf8'),
    ])
    const velaOptionKeys = new Set([
      ...extractInterfaceKeys(publicApi, 'VelaOptions'),
      ...extractInterfaceKeys(publicApi, 'ChannelVelaOptions'),
    ])
    const documentedOptions = extractSdkTableOptions(sdkDoc)
    if (documentedOptions.length === 0) {
      errors.push('docs/sdk.md: missing "## createVela options" table')
    } else {
      for (const opt of documentedOptions) {
        if (!velaOptionKeys.has(opt)) {
          errors.push(
            `docs/sdk.md: documented createVela option "${opt}" is absent from VelaOptions in packages/vela/api/public-api.txt (#576)`,
          )
        }
      }
    }
  }

  const settingsDoc = await readFile(join(root, 'docs/settings.md'), 'utf8')
  const upgradingDoc = await readFile(join(root, 'docs/upgrading.md'), 'utf8')
  const sessionsDoc = await readFile(join(root, 'docs/sessions.md'), 'utf8')
  const changelogDoc = await readFile(join(root, 'CHANGELOG.md'), 'utf8')
  const unreleased = extractUnreleasedSection(changelogDoc)

  if (
    !upgradingDoc.includes('trusted_paths') ||
    (!upgradingDoc.includes('$VELA_DIR/vela.db') &&
      !upgradingDoc.includes('~/.vela/vela.db'))
  ) {
    errors.push(
      'docs/upgrading.md: must document trusted_paths inside $VELA_DIR/vela.db (~/.vela/vela.db) (#581)',
    )
  }
  if (
    !settingsDoc.includes('env:<encodedOwnerDataDir>:<encodedName>:<posixCwd>')
  ) {
    errors.push(
      'docs/settings.md: must document container trust key format env:<encodedOwnerDataDir>:<encodedName>:<posixCwd> (#581)',
    )
  }

  for (const [label, content] of [
    ['docs/settings.md', settingsDoc],
    ['docs/upgrading.md', upgradingDoc],
    ['docs/sessions.md', sessionsDoc],
    ['CHANGELOG.md [Unreleased]', unreleased],
  ] as const) {
    if (
      !content.includes('$VELA_DIR/vela.db') &&
      !content.includes('~/.vela/vela.db')
    ) {
      errors.push(
        `${label}: must document $VELA_DIR/vela.db (~/.vela/vela.db) for CLI SQLite storage (#583)`,
      )
    }
  }
  for (const [label, content] of [
    ['docs/upgrading.md', upgradingDoc],
    ['docs/sessions.md', sessionsDoc],
    ['CHANGELOG.md [Unreleased]', unreleased],
  ] as const) {
    if (
      !content.includes('createVela({ dataDir })') ||
      !content.includes('<dataDir>/vela.db')
    ) {
      errors.push(
        `${label}: must distinguish SDK createVela({ dataDir }) fallback at <dataDir>/vela.db (#583)`,
      )
    }
  }
  for (const pattern of RETIRED_BEHAVIOR_CLAIMS) {
    if (pattern.test(unreleased)) {
      errors.push(
        `CHANGELOG.md [Unreleased]: claims removed automatic legacy migration (${pattern.source})`,
      )
    }
  }

  return errors
}

if (import.meta.main) {
  const failures = await checkDocsConsistency(join(import.meta.dir, '..'))
  if (failures.length > 0) {
    console.error(failures.join('\n'))
    process.exitCode = 1
  } else {
    console.log('docs consistency: ok')
  }
}
