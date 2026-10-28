import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * This installation's stable id (`<agentDir>/installation-id`, created on first use). Sign in with ChatGPT sends it
 * as the agent host id, so later sign-ins from this machine reuse one registration.
 */
export function installationId(agentDir: string): string {
  const file = join(agentDir, 'installation-id')
  if (existsSync(file)) {
    const id = readFileSync(file, 'utf-8').trim()
    if (UUID.test(id)) return id
  }
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
