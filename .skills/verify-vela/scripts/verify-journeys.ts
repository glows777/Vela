// Runs every offline journey script through vela-verify.sh exec, the isolated environment the scripts
// expect: own HOME, VELA_DIR, cwd, mock model and no network credentials. github-setup-journey.ts needs
// a package registry and stays out (run it by hand: see journeys.md).
//
//   bun run verify:journeys
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const HERE = import.meta.dir
const REPO = join(HERE, '../../..')
const HELPER = join(HERE, 'vela-verify.sh')
const RUN = `verify-journeys-${Date.now()}`
const EVIDENCE = join(
  process.env.VELA_EVIDENCE_ROOT ?? '/tmp/vela-evidence',
  RUN,
)
const SKIP = new Set([
  'github-setup-journey.ts',
  'verify-journeys.ts',
  'workspace.ts',
])

const scripts = readdirSync(HERE)
  .filter((name) => name.endsWith('.ts') && !SKIP.has(name))
  .sort()

const failures: string[] = []
try {
  for (const script of scripts) {
    const started = Date.now()
    const name = script.replace(/\.ts$/, '')
    const proc = Bun.spawn(
      ['bash', HELPER, 'exec', RUN, name, 'bun', join(HERE, script)],
      {
        cwd: REPO,
        env: process.env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        signal: AbortSignal.timeout(300_000),
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    if (code === 0) {
      console.log(`PASS ${script} (${seconds}s)`)
      continue
    }
    failures.push(script)
    console.error(`FAIL ${script} (exit ${code}, ${seconds}s)`)
    // exec captures the script's own output in evidence files; a CI runner is gone afterwards, so print
    // their tail here. stderr last: that's where a failed assertion lands.
    const captured = ['stdout', 'stderr'].map((stream) => {
      const file = join(EVIDENCE, `${name}.${stream}`)
      return existsSync(file) ? readFileSync(file, 'utf8') : ''
    })
    const tail = [...captured, stderr, stdout]
      .map((text) => text.trim())
      .filter(Boolean)
      .join('\n')
      .split('\n')
      .slice(-40)
      .join('\n')
    if (tail) console.error(tail)
  }
} finally {
  Bun.spawnSync(['bash', HELPER, 'cleanup', RUN], {
    cwd: REPO,
    stdout: 'ignore',
    stderr: 'inherit',
  })
  console.log(`Evidence: ${EVIDENCE}`)
}

if (failures.length) {
  console.error(
    `\n${failures.length} journey script(s) failed: ${failures.join(', ')}`,
  )
  process.exit(1)
}
console.log(`\nAll ${scripts.length} offline journey scripts passed.`)
