import { expect, test } from 'bun:test'
import { join, relative, resolve } from 'node:path'

/**
 * core (everything under src/ except the CLI and test tools) is an SDK other projects import:
 * it never writes to the terminal, exits the process, reads env vars, or touches readline. Output goes through events or an injected logger.
 */
const SRC = resolve(import.meta.dir, '../../src')

/** Allowed places: the CLI and test tools */
const ALLOWED = ['cli/', 'testing/']

const FORBIDDEN: [RegExp, string][] = [
  [/\bconsole\.\w+/, 'console'],
  [/\bprocess\.(stdout|stderr)\b/, 'process.stdout/stderr'],
  [/\bprocess\.exit\b/, 'process.exit'],
  [/\bprocess\.env\b/, 'process.env'],
  [/['"]node:readline['"]/, 'node:readline'],
]

/** Strip comments so prose mentioning process.env and the like is not flagged */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/(?! vela-boundary).*$/gm, '$1')
}

test('core modules do not write to the terminal, exit, read env or use readline', async () => {
  const violations: string[] = []
  for await (const file of new Bun.Glob('**/*.ts').scan(SRC)) {
    const path = file.replaceAll('\\', '/')
    if (ALLOWED.some((prefix) => path.startsWith(prefix))) continue
    const lines = stripComments(await Bun.file(join(SRC, file)).text()).split(
      '\n',
    )
    lines.forEach((line, i) => {
      if (lines[i - 1]?.includes('vela-boundary: allow')) return
      for (const [pattern, name] of FORBIDDEN)
        if (pattern.test(line))
          violations.push(`src/${path}:${i + 1} uses ${name}`)
    })
  }
  expect(violations).toEqual([])
})

test('the allow list only names paths that exist', async () => {
  for (const prefix of ALLOWED) {
    const glob = new Bun.Glob(prefix.endsWith('/') ? `${prefix}**` : prefix)
    const matches = await Array.fromAsync(glob.scan(SRC))
    expect(matches.length, relative(SRC, join(SRC, prefix))).toBeGreaterThan(0)
  }
})
