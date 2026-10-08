import { spawnSync } from 'node:child_process'
import { chmodSync, createWriteStream, existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { VelaLogger } from '../logger.ts'

/** External programs the search tools run (same as pi: grep → ripgrep, find → fd). */
export type ToolBinary = 'rg' | 'fd'

interface BinarySpec {
  name: string
  repo: string
  binaryName: string
  /** Names to look for on PATH (Debian/Ubuntu install fd as `fdfind`) */
  pathNames: string[]
  tagPrefix: string
  asset: (version: string, target: string) => string
  install: string
}

const SPECS: Record<ToolBinary, BinarySpec> = {
  rg: {
    name: 'ripgrep',
    repo: 'BurntSushi/ripgrep',
    binaryName: 'rg',
    pathNames: ['rg'],
    tagPrefix: '',
    asset: (version, target) => `ripgrep-${version}-${target}`,
    install: 'brew install ripgrep / apt install ripgrep',
  },
  fd: {
    name: 'fd',
    repo: 'sharkdp/fd',
    binaryName: 'fd',
    pathNames: ['fd', 'fdfind'],
    tagPrefix: 'v',
    asset: (version, target) => `fd-v${version}-${target}`,
    install: 'brew install fd / apt install fd-find',
  },
}

/** Release target triple and archive extension for this machine (same assets pi downloads). */
function releaseTarget(): { target: string; ext: string } | undefined {
  const cpu =
    arch() === 'arm64' ? 'aarch64' : arch() === 'x64' ? 'x86_64' : undefined
  if (!cpu) return
  switch (platform()) {
    case 'darwin':
      return { target: `${cpu}-apple-darwin`, ext: '.tar.gz' }
    case 'linux':
      return { target: `${cpu}-unknown-linux-musl`, ext: '.tar.gz' }
    case 'win32':
      return { target: `${cpu}-pc-windows-msvc`, ext: '.zip' }
  }
}

export interface BinaryResolverOptions {
  /**
   * Where downloaded binaries live (the CLI uses `~/.vela/bin`). Checked before PATH.
   * Without it only PATH is searched and nothing is downloaded.
   */
  binDir?: string
  /** Never download, even with `binDir` (the CLI sets this from `VELA_OFFLINE=1`). */
  offline?: boolean
  logger?: VelaLogger
  /** @internal Base URL of the release site (tests point it at a local server). */
  releaseBaseUrl?: string
}

export type BinaryResolver = (tool: ToolBinary) => Promise<string>

/**
 * Find rg / fd like pi's `ensureTool`: `binDir`, then PATH, then download the latest GitHub
 * release into `binDir`. Fails with an error that says how to install the program when none of
 * those works; the search tools have no fallback.
 */
export function createBinaryResolver(
  options: BinaryResolverOptions = {},
): BinaryResolver {
  const pending = new Map<ToolBinary, Promise<string>>()
  const baseUrl = options.releaseBaseUrl ?? 'https://github.com'
  return (tool) => {
    let found = pending.get(tool)
    if (!found) {
      found = resolveBinary(tool, options, baseUrl)
      // A failure is not cached: the next call tries again (network back, program installed)
      found.catch(() => pending.delete(tool))
      pending.set(tool, found)
    }
    return found
  }
}

async function resolveBinary(
  tool: ToolBinary,
  options: BinaryResolverOptions,
  baseUrl: string,
): Promise<string> {
  const spec = SPECS[tool]
  const exe = platform() === 'win32' ? '.exe' : ''
  if (options.binDir) {
    const local = join(options.binDir, spec.binaryName + exe)
    if (existsSync(local)) return local
  }
  for (const name of spec.pathNames) if (onPath(name)) return name

  const missing = `${spec.name} (${spec.binaryName}) is not installed`
  if (!options.binDir)
    throw new Error(
      `${missing}. Install it (${spec.install}) or pass binDir to createVela() to download it automatically`,
    )
  if (options.offline)
    throw new Error(
      `${missing} and VELA_OFFLINE is set, so it was not downloaded. Install it: ${spec.install}`,
    )
  options.logger?.info(
    `[tools] ${spec.name} not found, downloading to ${options.binDir}`,
  )
  try {
    const path = await download(spec, options.binDir, baseUrl, exe)
    options.logger?.info(`[tools] ${spec.name} installed to ${path}`)
    return path
  } catch (error) {
    const reason = errorChain(error)
    throw new Error(
      `${missing} and could not be downloaded (${reason}). Install it: ${spec.install}`,
    )
  }
}

function onPath(command: string): boolean {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' })
  return !result.error
}

async function download(
  spec: BinarySpec,
  binDir: string,
  baseUrl: string,
  exe: string,
): Promise<string> {
  const target = releaseTarget()
  if (!target)
    throw new Error(`no ${spec.name} release for ${platform()}/${arch()}`)
  // The release page redirect names the latest tag without using the rate-limited GitHub API (same as pi)
  const latest = await fetch(`${baseUrl}/${spec.repo}/releases/latest`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  })
  const location = latest.headers.get('location')
  if (!location?.includes('/releases/tag/'))
    throw new Error(
      `could not resolve the latest ${spec.repo} release (HTTP ${latest.status})`,
    )
  const tag = decodeURIComponent(
    new URL(location, baseUrl).pathname.split('/').pop() ?? '',
  )
  const version = tag.replace(/^v/, '')
  const asset = spec.asset(version, target.target)

  await mkdir(binDir, { recursive: true })
  // A private temp dir per download: rg and fd (or two processes) may download at the same time
  const work = await mkdtemp(join(binDir, `.download-${spec.binaryName}-`))
  try {
    const archive = join(work, asset + target.ext)
    const response = await fetch(
      `${baseUrl}/${spec.repo}/releases/download/${spec.tagPrefix}${version}/${asset}${target.ext}`,
      { signal: AbortSignal.timeout(120_000) },
    )
    if (!response.ok || !response.body)
      throw new Error(`download failed with HTTP ${response.status}`)
    await pipeline(
      Readable.fromWeb(
        response.body as import('node:stream/web').ReadableStream,
      ),
      createWriteStream(archive),
    )
    const out = join(work, 'out')
    await mkdir(out)
    extract(archive, out)
    const binary = findFile(out, spec.binaryName + exe)
    if (!binary)
      throw new Error(
        `${spec.binaryName + exe} not found in ${asset}${target.ext}`,
      )
    if (platform() !== 'win32') chmodSync(binary, 0o755)
    const dest = join(binDir, spec.binaryName + exe)
    await rename(binary, dest)
    return dest
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

function extract(archive: string, dir: string): void {
  // tar handles .tar.gz everywhere and .zip on Windows (bsdtar); unzip is the fallback for .zip
  const attempts = archive.endsWith('.zip')
    ? [
        ['tar', ['xf', archive, '-C', dir]],
        ['unzip', ['-q', archive, '-d', dir]],
      ]
    : [['tar', ['xzf', archive, '-C', dir]]]
  const failures: string[] = []
  for (const [command, args] of attempts as [string, string[]][]) {
    const result = spawnSync(command, args, { stdio: 'pipe' })
    if (!result.error && result.status === 0) return
    failures.push(
      `${command}: ${result.error?.message ?? (result.stderr.toString().trim() || `exit ${result.status}`)}`,
    )
  }
  throw new Error(`could not extract ${archive}: ${failures.join('; ')}`)
}

function findFile(dir: string, name: string): string | undefined {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return path
    if (entry.isDirectory()) {
      const found = findFile(path, name)
      if (found) return found
    }
  }
}

/** fetch failures say only "fetch failed"; the cause (DNS, TLS, timeout) is the useful part. */
function errorChain(error: unknown): string {
  const messages: string[] = []
  for (
    let current = error, depth = 0;
    current instanceof Error && depth < 5;
    current = current.cause, depth++
  )
    if (!messages.includes(current.message)) messages.push(current.message)
  return messages.join(': ') || String(error)
}
