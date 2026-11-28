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

const RETIRED_OPERATIONAL_PATTERNS = [
  { label: 'vela serve', pattern: /\bvela serve\b/ },
  { label: '--mode rpc', pattern: /--mode rpc\b/ },
  { label: 'createChannelVela', pattern: /\bcreateChannelVela\b/ },
  { label: 'startChannels(', pattern: /\bstartChannels\s*\(/ },
  { label: 'createVela(', pattern: /\bcreateVela\s*\(/ },
  { label: 'lark() factory', pattern: /`lark\(\)`|\blark\s*\(\{/ },
  {
    label: '@glows777/vela/legacy-desktop',
    pattern: /@glows777\/vela\/legacy-desktop|\blegacy-desktop\b/,
  },
  {
    label: 'retired channel_* tool',
    pattern:
      /\bchannel_(?:start_topic|list_topics|read_topic|message_topic|message_group|forward_to_topic|skip_reply|wait_for_input|send_file|subscriptions|routines|followups)\b/,
  },
  { label: 'session.ui', pattern: /\bsession\.ui\b/ },
  {
    label: 'top-level "local" config',
    pattern: /top-level\s+["'`]local["'`]/i,
  },
] as const

const RETIREMENT_NOTICE_RE =
  /\b(?:retired|removed|replaced|replaces|instead of|migration|upgrading|removed in v0\.9|legacy channel gateway|exit(?:s|ing)?\s+(?:with\s+)?code\s+2|fail(?:s|ing)?\s+fast)\b/i

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
  const sectionMarker = '## createRuntime options\n'
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
 * Enforces documentation consistency (#576, #581, #583, #591, #593, #599, #602) against
 * `public-api.txt` and current SQLite / config / Runtime SDK / CLI contracts.
 */
export async function checkDocsConsistency(root: string): Promise<string[]> {
  const errors: string[] = []

  const docFiles: string[] = []
  for await (const rel of new Glob('docs/**/*.md').scan(root)) {
    docFiles.push(join(root, rel))
  }
  docFiles.sort()

  const userFacingFiles = new Set<string>(docFiles)
  for (const extra of [
    'README.md',
    'packages/vela/README.md',
    '.skills/verify-vela/SKILL.md',
    '.skills/verify-vela/core.md',
    '.skills/verify-vela/journeys.md',
  ]) {
    const abs = join(root, extra)
    if (existsSync(abs)) userFacingFiles.add(abs)
  }
  for await (const rel of new Glob('.skills/verify-vela/scripts/*.ts').scan(
    root,
  )) {
    userFacingFiles.add(join(root, rel))
  }
  for await (const rel of new Glob('examples/**/*').scan(root)) {
    userFacingFiles.add(join(root, rel))
  }

  for (const file of [...userFacingFiles].sort()) {
    const rel = relative(root, file).replaceAll('\\', '/')
    const text = await readFile(file, 'utf8')
    const lines = text.split('\n')
    const isDoc = rel.startsWith('docs/')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (isDoc) {
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
      const clauses = line
        .split(/(?<=[.!?;])\s+|\s*\|\s*|\b(?:now that|since|whereas|while)\s+/i)
        .filter(Boolean)
      const isRetiredTableRow =
        line.trimStart().startsWith('|') &&
        RETIREMENT_NOTICE_RE.test(clauses[0] ?? '')
      if (!isRetiredTableRow) {
        for (const clause of clauses) {
          if (RETIREMENT_NOTICE_RE.test(clause)) continue
          for (const { label, pattern } of RETIRED_OPERATIONAL_PATTERNS) {
            if (pattern.test(clause)) {
              errors.push(
                `${rel}:${i + 1}: contains non-retirement operational reference to retired "${label}" (#599/#602)`,
              )
            }
          }
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
    const runtimeOptionKeys = extractInterfaceKeys(
      publicApi,
      'CreateRuntimeOptions',
    )
    const documentedOptions = extractSdkTableOptions(sdkDoc)
    const documentedSet = new Set(documentedOptions)
    if (documentedOptions.length === 0) {
      errors.push('docs/sdk.md: missing "## createRuntime options" table')
    } else {
      for (const opt of documentedOptions) {
        if (!runtimeOptionKeys.has(opt)) {
          errors.push(
            `docs/sdk.md: documented createRuntime option "${opt}" is absent from CreateRuntimeOptions in packages/vela/api/public-api.txt (#576)`,
          )
        }
      }
      for (const opt of runtimeOptionKeys) {
        if (!documentedSet.has(opt)) {
          errors.push(
            `docs/sdk.md: public CreateRuntimeOptions property "${opt}" is missing from "## createRuntime options" table (#576)`,
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

  const trustLines = upgradingDoc
    .split('\n')
    .filter((line) => line.includes('trusted_paths'))
  if (
    trustLines.length === 0 ||
    !trustLines.some(
      (line) =>
        (line.includes('$VELA_DIR/vela.db') ||
          line.includes('~/.vela/vela.db')) &&
        line.includes('env:<encodedOwnerDataDir>:<encodedName>:<posixCwd>') &&
        line.includes('env:<encodedName>:<posixCwd>') &&
        !line.includes('<dataDir>/vela.db'),
    )
  ) {
    errors.push(
      'docs/upgrading.md: trusted_paths entry must document $VELA_DIR/vela.db (~/.vela/vela.db) and both container trust keys (env:<encodedOwnerDataDir>:<encodedName>:<posixCwd> and env:<encodedName>:<posixCwd>) rather than <dataDir>/vela.db (#581)',
    )
  }
  if (
    !settingsDoc.includes(
      'env:<encodedOwnerDataDir>:<encodedName>:<posixCwd>',
    ) ||
    !settingsDoc.includes('env:<encodedName>:<posixCwd>')
  ) {
    errors.push(
      'docs/settings.md: must document both container trust key formats env:<encodedOwnerDataDir>:<encodedName>:<posixCwd> and env:<encodedName>:<posixCwd> (#581)',
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
      !content.includes('createRuntime({ agentDir })') ||
      !content.includes('<agentDir>/vela.db')
    ) {
      errors.push(
        `${label}: must distinguish SDK createRuntime({ agentDir }) storage at <agentDir>/vela.db (#583)`,
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

  const runtimeSdkPath = join(root, 'packages/vela/src/runtime-sdk.ts')
  const runtimeSdk = existsSync(runtimeSdkPath)
    ? await readFile(runtimeSdkPath, 'utf8')
    : undefined
  const sdkDefaultsHostEnvEmpty =
    runtimeSdk === undefined ||
    /const hostEnv = options\.hostEnv \?\? \{\}/.test(runtimeSdk)
  const sdkDocText = existsSync(sdkDocPath)
    ? await readFile(sdkDocPath, 'utf8')
    : ''
  const claimsDefaultProcessEnv = (text: string) =>
    /hostEnv`?[^\n.]*\bdefaults?\s+to\s+`?process\.env`?/i.test(text) ||
    /\bdefaults?\s+`?hostEnv`?\s+to\s+`?process\.env`?/i.test(text) ||
    /`?hostEnv`?[^\n.]*\binherits?\s+`?process\.env`?/i.test(text) ||
    /\binherits?\s+`?process\.env`?[^\n.]*`?hostEnv`?/i.test(text) ||
    /\bdefaults?\s+to\s+inheriting\s+`?process\.env`?/i.test(text)
  const statesDefaultEmptyObject = (text: string) =>
    /`?hostEnv`?\s+(?:defaults?|defaulting)\s+to\s+`?\{\}`?/i.test(text)

  if (claimsDefaultProcessEnv(unreleased)) {
    errors.push(
      'CHANGELOG.md [Unreleased]: falsely claims createRuntime() defaults hostEnv to process.env (it defaults to {}) (#593)',
    )
  }
  if (claimsDefaultProcessEnv(sdkDocText)) {
    errors.push(
      'docs/sdk.md: falsely claims createRuntime() defaults hostEnv to process.env (it defaults to {}) (#593)',
    )
  }
  if (sdkDefaultsHostEnvEmpty) {
    if (sdkDocText && !statesDefaultEmptyObject(sdkDocText)) {
      errors.push(
        'docs/sdk.md: must document that createRuntime() hostEnv defaults to {} (#593)',
      )
    }
    if (
      /\bhostEnv\b/.test(unreleased) &&
      !statesDefaultEmptyObject(unreleased)
    ) {
      errors.push(
        'CHANGELOG.md [Unreleased]: must agree with docs/sdk.md and runtime-sdk.ts that createRuntime() hostEnv defaults to {} (#593)',
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
