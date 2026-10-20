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

const ROOT = resolve(import.meta.dir, '..')
const SRC = join(ROOT, 'src')
const LINE_LIMIT = 800

/** Zero since #131 removed the last cycle. */
const MAX_CYCLES = 0

/** Files that were already over the limit when the ratchet landed, pinned at their size that day. */
const LINE_CEILINGS = new Map<string, number>([
  ['src/vela-session.ts', 1562],
  ['src/cli/interactive.ts', 1437],
  ['src/tools/registry.ts', 808],
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
    'Remove what knip lists. A file only scripts, examples or tests use belongs in knip.json.',
  ])
}

async function checkCycles() {
  const graph = await madge(SRC, { fileExtensions: ['ts'] })
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
        const path = cycle.map((file) => relative(ROOT, resolve(SRC, file)))
        return [...path, path[0]].join(' → ')
      }),
      '',
      'Two modules that import each other cannot be built, tested or deleted one at a time.',
      'Move the shared code into a module both import, or pass the value in (#131 removed the last cycle).',
    ],
  )
}

async function checkFileSizes() {
  const grown: string[] = []
  const untracked: string[] = []
  let largest: { path: string; lines: number; ceiling: number } | undefined
  let files = 0

  for await (const file of new Glob('**/*.ts').scan(SRC)) {
    files++
    const path = `src/${file}`
    const lines = countLines(await Bun.file(join(SRC, file)).text())
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
await checkCycles()
await checkFileSizes()
const elapsed = ((performance.now() - started) / 1000).toFixed(1)

if (failures.length > 0) {
  console.error(
    `\nquality: ${failures.length} of ${checks} checks failed in ${elapsed}s`,
  )
  process.exit(1)
}
console.log(`\nquality: all ${checks} checks passed in ${elapsed}s`)
