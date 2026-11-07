import { afterEach } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const githubEvents = [
  'check_suite',
  'pull_request_review',
  'issue_comment',
  'pull_request',
]
export const setupEntry = resolve(
  import.meta.dir,
  '../../packages/vela/src/cli/main.ts',
)
export const setupModule = resolve(
  import.meta.dir,
  '../../packages/vela/src/cli/github-setup.ts',
)
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
export interface Hook {
  id: number
  name?: string
  active?: boolean
  config: {
    url: string
    secret?: string
    content_type?: string
    insecure_ssl?: string
  }
  events?: string[]
}
export interface GhState {
  hooks: Record<string, Hook[]>
  calls: { args: string[]; input: string; settings: unknown }[]
  auth?: boolean
  fail?: string[]
  lost?: boolean
  echoSecret?: boolean
}
export function githubFixture() {
  const root = mkdtempSync(join(tmpdir(), 'vela-github-setup-'))
  dirs.push(root)
  const agentDir = join(root, 'user')
  const cwd = join(root, 'project')
  const bin = join(root, 'bin')
  const statePath = join(root, 'gh.json')
  mkdirSync(cwd)
  mkdirSync(bin)
  const settingsPath = join(agentDir, 'settings.json')
  const env = {
    HOME: root,
    VELA_DIR: agentDir,
    VELA_OFFLINE: '1',
    PATH: bin,
    GH_SETUP_STATE: statePath,
    TERM: 'xterm-256color',
  }
  const state = (): GhState => JSON.parse(readFileSync(statePath, 'utf8'))
  const setState = (value: Partial<GhState>) =>
    writeFileSync(statePath, JSON.stringify({ ...state(), ...value }))
  writeFileSync(statePath, JSON.stringify({ hooks: {}, calls: [] }))
  writeFileSync(
    join(bin, 'gh'),
    `#!${process.execPath}\n${readFileSync(join(import.meta.dir, 'github-setup-gh.ts'), 'utf8')}`,
    { mode: 0o700 },
  )
  const settings = () => JSON.parse(readFileSync(settingsPath, 'utf8'))
  const seed = (value: unknown) => {
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(settingsPath, JSON.stringify(value))
  }
  const cli = async (args: string[], extra: Record<string, string> = {}) => {
    const child = Bun.spawn(
      [process.execPath, '--no-env-file', setupEntry, ...args],
      {
        cwd,
        env: { ...env, ...extra },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, output: stdout + stderr, code }
  }
  return {
    root,
    cwd,
    agentDir,
    bin,
    env,
    settingsPath,
    state,
    setState,
    seed,
    settings,
    cli,
    saved: () => existsSync(settingsPath),
  }
}
