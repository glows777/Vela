import { resolveShellPath as resolveCoreShellPath } from '@glows777/vela-core'

interface ShellPathOptions {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
}

/** Resolve the CLI shell without allowing a `bash.cmd` shim to shadow Git Bash on Windows. */
export function resolveShellPath(
  shellPath?: string,
  { platform = process.platform, env = process.env }: ShellPathOptions = {},
): string {
  return resolveCoreShellPath(shellPath, { platform, env })
}
