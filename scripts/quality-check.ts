/**
 * Quality ratchet: three checks that stop the codebase from getting more tangled than it is today.
 *
 * - knip reports no unused files, exports or dependencies;
 * - madge finds no circular dependencies;
 * - no file under src/ passes 800 lines, except the files that were already over it when the limit
 *   landed: each is pinned at its size that day and may only shrink.
 *
 * The ceilings are numbers in this file. Lowering one is a normal edit; raising one should be
 * visible in review. `bun run quality` runs this locally, CI runs it after lint.
 */

import { join, relative, resolve } from 'node:path'
import { $, Glob } from 'bun'
// @ts-expect-error madge ships no type definitions
import madge from 'madge'
import { checkBoundaries } from './check-boundaries.ts'
import { readWorkspaces } from './workspaces.ts'

const ROOT = resolve(import.meta.dir, '..')
const SOURCES = ['core', 'channels', 'mcp', 'rag', 'lark', 'vela'].map((name) =>
  join(ROOT, 'packages', name, 'src'),
)
const LINE_LIMIT = 800

/** Zero since #131 removed the last cycle. */
const MAX_CYCLES = 0

/** Files that were already over the limit when the ratchet landed, pinned at their size that day. */
const LINE_CEILINGS = new Map<string, number>([
  ['packages/core/src/vela-session.ts', 1562],
  ['packages/vela/src/cli/interactive.ts', 1403],
  ['packages/core/src/tools/registry.ts', 808],
])

const failures: string[] = []
let checks = 0

function report(ok: boolean, summary: string, details: string[] = []) {
  checks++
  console.log(`${ok ? '✓' : '✗'} ${summary}`)
  for (const line of details) console.log(`  ${line}`.trimEnd())
  if (!ok) failures.push(summary)
}

/** Lines in a source file, counted the way `wc -l` counts, plus a last line without a newline. */
function countLines(source: string): number {
  const newlines = source.split('\n').length - 1
  return source.endsWith('\n') ? newlines : newlines + 1
}

async function checkDeadCode() {
  // --no-install: run the knip from the lockfile and never download one mid-check
  const knip = await $`bunx --no-install knip`.cwd(ROOT).quiet().nothrow()
  const output = `${knip.stdout.toString()}${knip.stderr.toString()}`.trim()
  if (knip.exitCode === 0) {
    report(true, 'knip: no unused files, exports or dependencies')
    return
  }
  report(false, 'knip: unused code found (the ratchet allows none)', [
    ...output.split('\n'),
    '',
    'Remove what knip lists. If the code is really reached from an entry knip cannot see, declare that',
    'entry in knip.json and say why in the PR; do not configure away a finding that is actually unused.',
  ])
}

async function checkRuntimeDependencies() {
  const result =
    await $`bunx --no-install knip --production --strict --workspace 'packages/*'`
      .cwd(ROOT)
      .quiet()
      .nothrow()
  const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim()
  report(
    result.exitCode === 0,
    'strict workspace runtime dependencies: ' +
      (result.exitCode === 0 ? 'ok' : 'failed'),
    result.exitCode === 0 ? [] : output.split('\n'),
  )
}

async function checkCycles() {
  const paths: Record<string, string[]> = {}
  for (const pkg of await readWorkspaces(ROOT))
    for (const [subpath, entry] of Object.entries(
      pkg.manifest.exports as Record<string, { import: string }>,
    ))
      paths[pkg.name + (subpath === '.' ? '' : subpath.slice(1))] = [
        relative(
          ROOT,
          resolve(
            pkg.dir,
            entry.import.replace('./dist/', 'src/').replace(/\.js$/, '.ts'),
          ),
        ),
      ]
  const graph = await madge(SOURCES, {
    baseDir: ROOT,
    fileExtensions: ['ts'],
    tsConfig: { compilerOptions: { baseUrl: ROOT, paths } },
    detectiveOptions: { ts: { skipTypeImports: true } },
  })
  const cycles: string[][] = graph.circular()
  if (cycles.length <= MAX_CYCLES) {
    report(
      true,
      `circular dependencies: ${cycles.length}, ceiling ${MAX_CYCLES}`,
    )
    return
  }
  report(
    false,
    `circular dependencies: ${cycles.length}, ceiling ${MAX_CYCLES}`,
    [
      ...cycles.map((cycle) => {
        const path = cycle.map((file) => relative(ROOT, resolve(ROOT, file)))
        return [...path, path[0]].join(' → ')
      }),
      '',
      'These modules now depend on each other, so a change in one reaches the other and neither can be',
      'reasoned about, tested or deleted on its own.',
      'Move the shared code into a module both import, or pass the value in (#131 removed the last cycle).',
    ],
  )
}

async function checkFileSizes() {
  const grown: string[] = []
  const untracked: string[] = []
  let largest: { path: string; lines: number; ceiling: number } | undefined
  let files = 0

  for (const source of SOURCES)
    for await (const file of new Glob('**/*.ts').scan(source)) {
      files++
      const path = relative(ROOT, join(source, file))
      const lines = countLines(await Bun.file(join(source, file)).text())
      const ceiling = LINE_CEILINGS.get(path)
      if (ceiling === undefined) {
        if (lines > LINE_LIMIT)
          untracked.push(
            `${path}: ${lines} lines, over the ${LINE_LIMIT}-line limit`,
          )
        continue
      }
      if (lines > ceiling)
        grown.push(
          `${path}: ${lines} lines, ${lines - ceiling} over its ceiling of ${ceiling}`,
        )
      if (!largest || lines > largest.lines) largest = { path, lines, ceiling }
    }

  const oversized = [...grown, ...untracked].sort()
  if (oversized.length === 0) {
    const closest = largest
      ? `, largest ${largest.path} at ${largest.lines}/${largest.ceiling}`
      : ''
    report(true, `file size: ${files} files within limits${closest}`)
    return
  }

  const details = [...oversized, '']
  if (grown.length > 0) {
    details.push(
      'Split the file and lower its ceiling in scripts/quality-check.ts; ceilings only come down.',
    )
  }
  if (untracked.length > 0) {
    details.push(
      `Split files before they reach ${LINE_LIMIT} lines; the allowlist only holds files that were already over it.`,
    )
  }
  report(
    false,
    `file size: ${oversized.length} file(s) over their limit`,
    details,
  )
}

const started = performance.now()
await checkDeadCode()
await checkRuntimeDependencies()
await checkCycles()
await checkFileSizes()
const boundaries = await checkBoundaries(ROOT)
report(
  boundaries.length === 0,
  `package boundaries: ${boundaries.length === 0 ? 'ok' : 'failed'}`,
  boundaries,
)
const elapsed = ((performance.now() - started) / 1000).toFixed(1)

if (failures.length > 0) {
  console.error(
    `\nquality: ${failures.length} of ${checks} checks failed in ${elapsed}s`,
  )
  process.exit(1)
}
console.log(`\nquality: all ${checks} checks passed in ${elapsed}s`)
