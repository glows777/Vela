import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

interface ShellPathOptions {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
}

/** Resolve the CLI shell without allowing a `bash.cmd` shim to shadow Git Bash on Windows. */
export function resolveShellPath(
  shellPath?: string,
  { platform = process.platform, env = process.env }: ShellPathOptions = {},
): string {
  if (shellPath) return shellPath
  if (platform !== 'win32') return 'bash'

  const candidates = [
    env.ProgramFiles && join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    env['ProgramFiles(x86)'] &&
      join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    env.ProgramW6432 && join(env.ProgramW6432, 'Git', 'bin', 'bash.exe'),
    env.LOCALAPPDATA &&
      join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    candidates.push(join(directory, 'bash.exe'))
    if (/(?:^|[\\/])cmd[\\/]?$/i.test(directory))
      candidates.push(join(dirname(directory), 'bin', 'bash.exe'))
  }

  return candidates.find((candidate) => existsSync(candidate)) ?? 'bash.exe'
}
