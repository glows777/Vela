import { readFileSync } from 'node:fs'

/**
 * The CLI's own version, read from the package manifest. `src/cli/` and `dist/cli/` both sit one
 * level below `packages/vela`, so the same relative URL works from source and from a build.
 */
export function cliVersion(): string {
  const file = new URL('../../package.json', import.meta.url)
  return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version
}
