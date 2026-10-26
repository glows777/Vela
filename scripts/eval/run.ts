import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ScenarioId, scenarioIds } from './graders.ts'
import { type Attempt, emptyUsage, pricing, table } from './report.ts'
import { compactionFixture, OLD_COMMIT } from './scenarios.ts'

const help =
  'bun scripts/eval/run.ts [--only C1,G2] [--runs 3] [--thinking max] [--max-cost-usd 3] [--repo <path>]'
// Preserve network routing without copying arbitrary user environment or credentials.
function networkEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
  ]) {
    const value = process.env[name]
    if (value) env[name] = value
  }
  return env
}
export async function workerEnvironment(artifactDir: string, scratch: string) {
  const home = join(artifactDir, 'home')
  const bin = join(home, 'bin')
  await mkdir(bin, { recursive: true })
  await symlink(process.execPath, join(bin, 'bun'))
  const path = `${bin}:${process.env.PATH ?? ''}`
  const bashEnv = join(home, 'bash-env')
  await Bun.write(bashEnv, `export PATH='${path.replaceAll("'", "'\\''")}'\n`)
  return {
    ...networkEnvironment(),
    PATH: path,
    HOME: home,
    VELA_DIR: join(home, '.vela'),
    VELA_OFFLINE: '1',
    TMPDIR: scratch,
    BASH_ENV: bashEnv,
  }
}
export function options(args: string[]) {
  const result = {
    only: [...scenarioIds] as ScenarioId[],
    runs: 3,
    thinking: 'max',
    maxCost: 3,
    repo: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    const value = args[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${flag}`)
    switch (flag) {
      case '--only': {
        const ids = value.split(',')
        if (
          !ids.length ||
          ids.some((id) => !scenarioIds.includes(id as ScenarioId))
        )
          throw new Error('Unknown scenario in --only')
        result.only = [...new Set(ids)] as ScenarioId[]
        break
      }
      case '--runs':
        result.runs = Number(value)
        if (!Number.isInteger(result.runs) || result.runs < 1)
          throw new Error('--runs must be a positive integer')
        break
      case '--thinking':
        if (
          !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(
            value,
          )
        )
          throw new Error('Invalid --thinking')
        result.thinking = value
        break
      case '--max-cost-usd':
        result.maxCost = Number(value)
        if (!Number.isFinite(result.maxCost) || result.maxCost <= 0)
          throw new Error('--max-cost-usd must be positive')
        break
      case '--repo':
        result.repo = resolve(value)
        break
      default:
        throw new Error(`Unknown option ${flag}`)
    }
  }
  return result
}

async function checked(cwd: string, args: string[]) {
  const process = Bun.spawn(args, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...networkEnvironment(), PATH: Bun.env.PATH, HOME: Bun.env.HOME },
  })
  const [stdout, , exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exit)
    throw new Error(
      `Command failed: ${args.slice(0, 2).join(' ')} (exit ${exit})`,
    )
  return stdout.trim()
}

async function main() {
  if (process.argv.slice(2).includes('--help')) {
    console.log(help)
    return
  }
  const config = options(process.argv.slice(2))
  const git = (...args: string[]) => checked(config.repo, ['git', ...args])
  const sha = await git('rev-parse', 'HEAD')
  const dirty = !!(await git('status', '--porcelain'))
  await git('cat-file', '-e', `${OLD_COMMIT}^{commit}`)
  if (!existsSync(join(config.repo, 'node_modules')))
    throw new Error(
      'Run bun install --frozen-lockfile in the selected checkout first',
    )
  // Read only after argument/repository validation; never put the value in config, argv or files.
  const apiKey = process.env.OPENAI_KEY
  if (!apiKey)
    throw new Error(
      'OPENAI_KEY is required; no credential fallback is performed',
    )
  const root = join(
    config.repo,
    '.vela-eval',
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${sha.slice(0, 8)}`,
  )
  const scratch = await mkdtemp(join(tmpdir(), 'vela-eval-'))
  const oldRuntime = join(scratch, 'old-runtime')
  const attempts: Attempt[] = []
  let remaining = config.only.length * config.runs * 2
  let capped = false
  const cost = () =>
    attempts.reduce((sum, attempt) => sum + attempt.usage.cost, 0)
  const save = async () => {
    await Bun.write(
      join(root, 'results.json'),
      JSON.stringify(
        {
          version: 1,
          oldCommit: OLD_COMMIT,
          newCommit: sha,
          dirty,
          options: config,
          pricing,
          compactionFixture,
          remaining,
          capped,
          estimatedCost: cost(),
          attempts,
        },
        null,
        2,
      ),
    )
  }
  await mkdir(root, { recursive: true })
  await save()
  try {
    await git('worktree', 'add', '--detach', oldRuntime, OLD_COMMIT)
    // Install only in the owned baseline worktree, using that revision's frozen lock.
    await checked(oldRuntime, [
      process.execPath,
      '--no-env-file',
      'install',
      '--frozen-lockfile',
    ])
    schedule: for (const scenario of config.only)
      for (let run = 1; run <= config.runs; run++)
        for (const arm of ['old', 'new'] as const) {
          if (arm === 'old' && scenario === 'G2') {
            attempts.push({
              scenario,
              arm,
              run,
              attempt: 0,
              status: 'skipped',
              reason: 'Baseline start_topic takes task, not title/brief',
              checks: [],
              usage: emptyUsage(),
              durationMs: 0,
              sessionFiles: [],
              finalChars: 0,
              toolCalls: 0,
              artifactDir: '',
            })
            remaining--
            await save()
            continue
          }
          for (let attempt = 1; attempt <= 2; attempt++) {
            if (cost() >= config.maxCost) {
              capped = true
              break schedule
            }
            const artifactDir = join(
              root,
              `${scenario}-${arm}-${run}-${attempt}`,
            )
            const cwd = join(scratch, `${scenario}-${arm}-${run}-${attempt}`)
            const runtime = arm === 'old' ? oldRuntime : config.repo
            const env = await workerEnvironment(artifactDir, scratch)
            await git('worktree', 'add', '--detach', cwd, OLD_COMMIT)
            try {
              await symlink(
                join(runtime, 'node_modules'),
                join(cwd, 'node_modules'),
                'dir',
              )
              const workerConfig = {
                runtime,
                cwd,
                artifactDir,
                scenario,
                arm,
                run,
                attempt,
                thinking: config.thinking,
              }
              const configPath = join(artifactDir, 'config.json')
              await Bun.write(configPath, JSON.stringify(workerConfig))
              const child = Bun.spawn(
                [
                  process.execPath,
                  '--no-env-file',
                  join(dirname(fileURLToPath(import.meta.url)), 'worker.ts'),
                  configPath,
                ],
                {
                  cwd,
                  stdin: 'pipe',
                  stdout: 'ignore',
                  stderr: 'ignore',
                  env,
                  timeout:
                    (['C4', 'C5', 'C6'].includes(scenario)
                      ? 600_000
                      : 300_000) + 15_000,
                },
              )
              child.stdin.write(apiKey)
              child.stdin.end()
              await child.exited
              const result = (await Bun.file(join(artifactDir, 'result.json'))
                .json()
                .catch(async () => ({
                  scenario,
                  arm,
                  run,
                  attempt,
                  status: 'error',
                  reason:
                    'Worker exited without a completed result (startup failure or deadline)',
                  checks: [],
                  usage: await Bun.file(join(artifactDir, 'usage.json'))
                    .json()
                    .catch(() => ({ ...emptyUsage(), unknown: 1 })),
                  durationMs: 0,
                  sessionFiles: [],
                  finalChars: 0,
                  toolCalls: 0,
                  artifactDir,
                }))) as Attempt
              attempts.push(result)
              if (result.status !== 'error' || attempt === 2) remaining--
              await save()
              console.error(
                `${scenario}/${arm}/${run}/attempt-${attempt}: ${result.status}`,
              )
              if (result.status !== 'error') break
            } finally {
              await git('worktree', 'remove', '--force', cwd)
            }
          }
        }
  } finally {
    // Only owned temporary worktrees are removed. Artifacts survive all outcomes.
    if (existsSync(oldRuntime))
      await git('worktree', 'remove', '--force', oldRuntime)
    await rm(scratch, { recursive: true, force: true })
    await save()
    console.log(table(attempts, config.only, config.runs))
    console.log(
      `\nEstimated total: $${cost().toFixed(6)}; unstarted slots: ${remaining}${capped ? '; cost cap reached (partial results)' : ''}\nArtifacts: ${root}`,
    )
    if (
      capped ||
      attempts.some(
        (attempt) => attempt.status === 'error' && attempt.attempt === 2,
      )
    )
      process.exitCode = 1
  }
}
if (import.meta.main)
  main().catch((error: unknown) => {
    // Only runner-owned validation messages, never raw provider errors, reach this boundary.
    console.error(error instanceof Error ? error.message : 'Eval runner failed')
    process.exitCode = 1
  })
