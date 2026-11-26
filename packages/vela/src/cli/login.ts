import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const INSTALLATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function readValidInstallationId(agentDir: string): string | undefined {
  const file = join(agentDir, 'installation-id')
  if (!existsSync(file)) return undefined
  const id = readFileSync(file, 'utf-8').trim()
  return INSTALLATION_ID_RE.test(id) ? id : undefined
}

/**
 * This installation's stable id (`<agentDir>/installation-id`, created on first use). Sign in with ChatGPT sends it
 * as the agent host id, so later sign-ins from this machine reuse one registration.
 */
export function installationId(agentDir: string): string {
  const existing = readValidInstallationId(agentDir)
  if (existing) return existing
  const file = join(agentDir, 'installation-id')
  const id = randomUUID()
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(file, `${id}\n`)
  return id
}

/**
 * Opens a URL in the default browser, best effort (pi's openBrowser): the URL is also shown, so a missing launcher
 * is not an error. Never goes through a shell, so the URL cannot inject commands.
 */
export function openBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]]
  spawn(command, args, { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref()
}
