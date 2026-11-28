import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Locations of built-in Vela documentation directories injected into `<docs>`. */
export interface DocsPaths {
  readme?: string
  docs?: string
  examples?: string
}

/**
 * Resolves Vela's bundled `README.md`, `docs/`, and `examples/` directories lazily using
 * `dirname(fileURLToPath(import.meta.url))` so bundlers (e.g. Vite) do not rewrite
 * `new URL('../..', import.meta.url)` into a `data:` URL that throws on `fileURLToPath`.
 */
export function defaultDocsPaths(): DocsPaths | undefined {
  if (!import.meta.url.startsWith('file:')) return undefined
  const packageDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
  )
  return {
    readme: join(packageDir, 'README.md'),
    docs: join(packageDir, 'docs'),
    examples: join(packageDir, 'examples'),
  }
}
