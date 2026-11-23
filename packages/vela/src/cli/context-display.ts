import { isAbsolute, relative, sep } from 'node:path'

// Lightweight CSI/OSC/APC/DCS/PM/SOS/ESC sequence stripper so print mode never pulls in @earendil-works/pi-tui.
const ANSI_ESCAPE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional terminal escape stripping
  /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|[_PX^][\s\S]*?(?:\x1b\\|\x07|$)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g

function isUnder(path: string, root: string): boolean {
  if (!root) return false
  if (path === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return path.startsWith(prefix)
}

function suffixUnder(path: string, root: string): string {
  if (path === root) return ''
  if (root === sep) return path
  const base = root.endsWith(sep) ? root.slice(0, -1) : root
  if (path === base) return ''
  const rest = path.slice(base.length)
  if (rest === '' || rest.startsWith(sep)) return rest
  return sep + rest
}

export function presentPath(
  path: string,
  homeDir: string,
  agentDir: string | undefined,
): string {
  if (isUnder(path, homeDir)) return `~${suffixUnder(path, homeDir)}`
  if (agentDir && isUnder(path, agentDir))
    return `$VELA_DIR${suffixUnder(path, agentDir)}`
  return path
}

export function formatContextFileList(
  files: readonly { path: string }[],
  options: { cwd: string; homeDir: string; agentDir?: string },
): string {
  const labels: string[] = []
  for (const file of files) {
    const label = displayContextPath(file.path, options)
    if (label) labels.push(label)
  }
  return labels.join(', ')
}

function displayContextPath(
  filePath: string,
  options: { cwd: string; homeDir: string; agentDir?: string },
): string {
  const fromCwd = relative(options.cwd, filePath)
  const insideCwd =
    fromCwd !== '' &&
    !isAbsolute(fromCwd) &&
    fromCwd !== '..' &&
    !fromCwd.startsWith(`..${sep}`)
  const label = insideCwd
    ? fromCwd
    : presentPath(filePath, options.homeDir, options.agentDir)
  return sanitizeDisplayPath(label)
}

function sanitizeDisplayPath(path: string): string {
  let out = ''
  for (const char of path.replace(ANSI_ESCAPE, '')) {
    const code = char.codePointAt(0) ?? 0
    if (code === 10 || code === 13) {
      out += ' '
      continue
    }
    if (
      code < 32 ||
      (code >= 127 && code <= 159) ||
      (code >= 0xfff9 && code <= 0xfffb)
    )
      continue
    out += char
  }
  return out.trim()
}
