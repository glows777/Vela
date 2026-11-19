import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

// Both artifacts are private to the owner-side resolver. Only guest.cjs goes through Docker argv.
export async function buildDockerAdapter(outdir: string) {
  await mkdir(outdir, { recursive: true })
  for (const [file, format] of [
    ['guest', 'cjs'],
    ['adapter', 'esm'],
  ] as const) {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, `${file}.ts`)],
      target: 'node',
      format,
      outdir,
      naming: file + (format === 'cjs' ? '.cjs' : '.mjs'),
    })
    if (!built.success)
      throw new AggregateError(built.logs, 'Docker adapter build failed')
  }
}
