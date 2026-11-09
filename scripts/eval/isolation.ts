import { existsSync } from 'node:fs'
import { mkdir, readdir, realpath, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ToolDefinition } from '@glows777/vela-core'
import { runtimePaths } from './layout.ts'

const DISK_TOOLS = new Set([
  'bash',
  'read_file',
  'write_file',
  'edit_file',
  'grep',
  'find',
  'list_directory',
])
export interface IsolationEvidence {
  profile: 'workspace-v1'
  preflight: 'pending' | 'passed' | 'failed'
  failure?: string
  phases: {
    task: {
      name: string
      args: unknown
      confined: boolean
      sessionId?: string
      resultsDir: string
    }[]
    recall: {
      name: string
      args: unknown
      confined: boolean
      sessionId?: string
      resultsDir: string
    }[]
  }
}

/** Filesystem isolation belongs to the evaluator, never to the product's tool implementation. */
export class MemoryIsolation {
  // Retain revision-native per-session file guards across isolated tool processes.
  private fileStates = new WeakMap<object, unknown>()
  private tails = new WeakMap<object, Promise<void>>()
  readonly evidence: IsolationEvidence = {
    profile: 'workspace-v1',
    preflight: 'pending',
    phases: { task: [], recall: [] },
  }
  private readonly source: string
  private readonly nativeFileState: boolean
  constructor(
    private runtime: string,
    private workspace: string,
    private dataDir: string,
    private artifactDir: string,
  ) {
    const paths = runtimePaths(runtime)
    this.source = paths.workspace
      ? paths.source
        ? 'packages/core/src'
        : 'packages/core/dist'
      : 'src'
    this.nativeFileState = existsSync(
      join(
        runtime,
        this.source,
        `tools/file-write-guard.${this.source.endsWith('/dist') ? 'js' : 'ts'}`,
      ),
    )
  }

  private async argv(resultsDir: string) {
    await mkdir(resultsDir, { recursive: true })
    const args = [
      '--die-with-parent',
      '--new-session',
      '--unshare-all',
      '--clearenv',
      '--ro-bind',
      '/usr',
      '/usr',
      '--symlink',
      'usr/bin',
      '/bin',
      '--symlink',
      'usr/lib',
      '/lib',
      '--symlink',
      'usr/lib64',
      '/lib64',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--dir',
      '/tools',
      '--dir',
      '/runtime',
      '--ro-bind',
      await realpath(process.execPath),
      '/tools/bun',
      '--ro-bind',
      join(import.meta.dir, 'sandbox-tool.ts'),
      '/tools/dispatch.ts',
      '--ro-bind',
      join(this.runtime, 'node_modules'),
      '/runtime/node_modules',
      '--ro-bind',
      join(this.runtime, this.source),
      `/runtime/${this.source}`,
      '--bind',
      this.workspace,
      this.workspace,
      '--bind',
      resultsDir,
      resultsDir,
      '--setenv',
      'PATH',
      '/tools:/usr/local/bin:/usr/bin:/bin',
      '--setenv',
      'HOME',
      '/tmp/home',
      '--setenv',
      'VELA_OFFLINE',
      '1',
      '--chdir',
      this.workspace,
    ]
    for (const name of ['fd', 'rg']) {
      const binary = Bun.which(name)
      if (binary)
        args.push('--ro-bind', await realpath(binary), `/tools/${name}`)
    }
    const packageDir = dirname(this.source)
    if (
      packageDir !== '.' &&
      existsSync(join(this.runtime, packageDir, 'node_modules'))
    )
      args.push(
        '--ro-bind',
        join(this.runtime, packageDir, 'node_modules'),
        `/runtime/${packageDir}/node_modules`,
      )
    // Only actual memory notes are visible. Never mount .dream/inbox or raw sessions.
    for (const dir of [
      join(dirname(this.workspace), 'memory'),
      join(this.dataDir, 'memory'),
    ]) {
      args.push('--dir', dir)
      for (const file of await readdir(dir, { withFileTypes: true }).catch(
        () => [],
      ))
        if (file.isFile() && file.name.endsWith('.md'))
          args.push('--ro-bind', join(dir, file.name), join(dir, file.name))
    }
    return args
  }

  private async run(
    command: string[],
    input = '',
    signal?: AbortSignal,
    resultsDir = join(this.dataDir, '.preflight-results'),
  ) {
    if (process.platform !== 'linux' || !Bun.which('bwrap'))
      throw new Error('Memory isolation requires Linux and bubblewrap')
    const child = Bun.spawn(
      ['bwrap', ...(await this.argv(resultsDir)), ...command],
      {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { PATH: process.env.PATH },
      },
    )
    const abort = () => child.kill()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.stdin.write(input)
    child.stdin.end()
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (exit !== 0)
        throw new Error(
          `Isolated tool process failed (${exit}): ${stderr.slice(0, 300)}`,
        )
      return stdout
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  async install(
    registry: { getAllTools(): ToolDefinition[] },
    phase: () => number,
  ) {
    await mkdir(this.workspace, { recursive: true })
    const canary = join(this.artifactDir, 'isolation-canary.txt')
    const visible = join(this.workspace, '.boundary-probe.txt')
    await writeFile(canary, 'private evaluation evidence')
    await writeFile(visible, 'visible workspace probe')
    try {
      const allowed = JSON.parse(
        await this.run(
          [
            '/tools/bun',
            '/tools/dispatch.ts',
            this.source,
            'read_file',
            this.workspace,
          ],
          JSON.stringify({
            input: { path: visible },
            resultsDir: join(this.dataDir, '.preflight-results'),
          }),
        ),
      )
      if (!JSON.stringify(allowed).includes('visible workspace probe'))
        throw new Error('Workspace read failed inside isolation')
      const input = JSON.stringify({
        input: { path: canary },
        resultsDir: join(this.dataDir, '.preflight-results'),
      })
      const result = JSON.parse(
        await this.run(
          [
            '/tools/bun',
            '/tools/dispatch.ts',
            this.source,
            'read_file',
            this.workspace,
          ],
          input,
        ),
      )
      if (result.kind !== 'error')
        throw new Error('Artifact canary was readable inside isolation')
      this.evidence.preflight = 'passed'
    } catch (error) {
      this.evidence.preflight = 'failed'
      this.evidence.failure =
        error instanceof Error ? error.message : 'Isolation failed'
      throw error
    } finally {
      await unlink(visible)
    }
    const types = await import(
      pathToFileURL(
        join(
          this.runtime,
          this.source,
          `tools/types.${this.source.endsWith('/dist') ? 'js' : 'ts'}`,
        ),
      ).href
    )
    const stored = await import(
      pathToFileURL(
        join(
          this.runtime,
          this.source,
          `session/tool-results.${this.source.endsWith('/dist') ? 'js' : 'ts'}`,
        ),
      ).href
    )
    for (const tool of registry.getAllTools()) {
      if (!DISK_TOOLS.has(tool.name)) continue
      tool.execute = async (args, context) => {
        const owner =
          this.nativeFileState &&
          ['read_file', 'write_file', 'edit_file'].includes(tool.name)
            ? context?.registry
            : undefined
        let release: (() => void) | undefined
        if (
          owner &&
          ['read_file', 'write_file', 'edit_file'].includes(tool.name)
        ) {
          const previous = this.tails.get(owner)
          this.tails.set(
            owner,
            new Promise<void>((resolve) => {
              release = resolve
            }),
          )
          await previous
        }
        try {
          const resultsDir =
            context?.results.dir ?? join(this.dataDir, '.direct-results')
          const observation = {
            name: tool.name,
            args,
            confined: true,
            sessionId: context?.sessionId,
            resultsDir,
          }
          this.evidence.phases[phase() === 0 ? 'task' : 'recall'].push(
            observation,
          )
          const envelope = JSON.parse(
            await this.run(
              [
                '/tools/bun',
                '/tools/dispatch.ts',
                this.source,
                tool.name,
                this.workspace,
              ],
              JSON.stringify({
                input: args,
                resultsDir,
                callId: context?.callId,
                ...(owner
                  ? { fileState: this.fileStates.get(owner) ?? [] }
                  : {}),
              }),
              context?.signal,
              resultsDir,
            ),
          )
          const value = envelope.result
          if (owner && envelope.fileState)
            this.fileStates.set(owner, envelope.fileState)
          if (envelope.kind === 'error') throw new Error(envelope.message)
          if (envelope.kind === 'execution')
            return new types.ToolExecutionResult(
              value.value,
              value.content ?? value.text,
              value.execution,
            )
          if (envelope.kind === 'stored') {
            const result = new stored.StoredToolResult(
              value.path,
              context?.results.indexPath ?? value.indexPath,
              value.bytes,
              value.preview,
              value.read,
            )
            return Object.assign(result, value, {
              indexPath: context?.results.indexPath ?? value.indexPath,
            })
          }
          return value
        } finally {
          release?.()
        }
      }
    }
  }
}
