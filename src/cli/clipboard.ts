import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Terminals cap OSC 52 payloads; pi uses the same limit. */
const MAX_OSC52_ENCODED_LENGTH = 100_000

export interface ClipboardOptions {
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  /** Writes an OSC 52 sequence to the terminal (the TUI passes its terminal) */
  writeTerminal?: (data: string) => void
}

/**
 * Copies text to the system clipboard (like pi's `copyToClipboard`, without its optional native
 * module): pbcopy / clip / wl-copy / xclip / xsel, the Windows clipboard from WSL, and OSC 52
 * through the terminal over SSH or without a display. Throws with what to install when nothing works.
 */
export async function copyToClipboard(
  text: string,
  options: ClipboardOptions = {},
): Promise<void> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const writeTerminal =
    options.writeTerminal ?? ((data: string) => process.stdout.write(data))
  const osc52 = () => {
    const encoded = Buffer.from(text).toString('base64')
    if (encoded.length > MAX_OSC52_ENCODED_LENGTH) return false
    writeTerminal(`\x1b]52;c;${encoded}\x07`)
    return true
  }

  const commands: [string, string[]][] = []
  if (platform === 'darwin') commands.push(['pbcopy', []])
  else if (platform === 'win32') commands.push(['clip', []])
  else {
    if (env.TERMUX_VERSION) commands.push(['termux-clipboard-set', []])
    if (env.WAYLAND_DISPLAY) commands.push(['wl-copy', []])
    if (env.DISPLAY)
      commands.push(
        ['xclip', ['-selection', 'clipboard']],
        ['xsel', ['--clipboard', '--input']],
      )
  }
  let copied = false
  for (const [command, args] of commands)
    if ((await run(command, args, env, text)) !== undefined) {
      copied = true
      break
    }
  let osc52Sent = false
  if (!copied && platform === 'linux' && isWSL(env)) {
    // Windows Terminal supports OSC 52; otherwise go through PowerShell
    if (env.WT_SESSION) osc52Sent = osc52()
    copied = osc52Sent || (await copyViaWindowsClipboard(text, env))
  }
  // OSC 52 can't be verified, so with a display a failure is reported instead; over SSH it is the
  // only way to reach the client's clipboard, and without a display the only way at all
  const headless =
    platform === 'linux' &&
    !env.DISPLAY &&
    !env.WAYLAND_DISPLAY &&
    !env.TERMUX_VERSION
  const remote = Boolean(
    env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION,
  )
  let oversized = false
  if (!osc52Sent && (remote || (!copied && headless))) {
    if (osc52()) copied = true
    else oversized = true
  }
  if (copied) return
  if (oversized)
    throw new Error('Clipboard unavailable: text exceeds the OSC 52 size limit')
  if (env.TERMUX_VERSION)
    throw new Error(
      'Clipboard unavailable: install the Termux:API app and `termux-api` package',
    )
  if (platform === 'linux' && env.WAYLAND_DISPLAY)
    throw new Error(
      'Clipboard unavailable: install `wl-clipboard` (`wl-copy`) or check Wayland access',
    )
  if (platform === 'linux' && env.DISPLAY)
    throw new Error(
      'Clipboard unavailable: install `xclip` or `xsel`, or check X11 access',
    )
  throw new Error('Clipboard unavailable')
}

function isWSL(env: Record<string, string | undefined>): boolean {
  if (env.WSL_DISTRO_NAME || env.WSLENV) return true
  try {
    return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf-8'))
  } catch {
    return false
  }
}

/**
 * PowerShell reads the text from a file: `clip.exe` and PowerShell stdin decode piped bytes with
 * the console code page, which mangles non-ASCII text (same as pi).
 */
async function copyViaWindowsClipboard(
  text: string,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const file = join(tmpdir(), `vela-wsl-clip-${randomUUID()}.txt`)
  try {
    writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 })
    const winPath = (await run('wslpath', ['-w', file], env))
      ?.toString('utf8')
      .trim()
    if (!winPath) return false
    const script = `Set-Clipboard -Value ([System.IO.File]::ReadAllText('${winPath.replaceAll("'", "''")}', [System.Text.Encoding]::UTF8))`
    return (
      (await run('powershell.exe', ['-NoProfile', '-Command', script], env)) !==
      undefined
    )
  } catch {
    return false
  } finally {
    try {
      unlinkSync(file)
    } catch {}
  }
}

/**
 * Runs a clipboard command; resolves to its stdout, or undefined when it is missing, fails or takes
 * longer than 5 s. With input, stdout is not piped: clipboard writers can daemonize and keep it open.
 */
function run(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  input?: string,
): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      stdio: ['pipe', input === undefined ? 'pipe' : 'ignore', 'ignore'],
      windowsHide: true,
    })
    const chunks: Buffer[] = []
    let settled = false
    const finish = (result: Buffer | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(undefined)
    }, 5000)
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.once('error', () => finish(undefined))
    child.once('close', (code) =>
      finish(code === 0 ? Buffer.concat(chunks) : undefined),
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(input ?? '')
  })
}
