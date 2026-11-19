import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

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
    // Linux limits each exec argument to 128 KiB. Transport the bundled, trusted guest
    // (including the existing YAML parser) in one argv entry on every supported host.
    if (file === 'guest') {
      const asset = join(outdir, 'guest.cjs')
      const encoded = gzipSync(await readFile(asset)).toString('base64')
      const guest = `require('node:vm').runInThisContext(require('node:zlib').gunzipSync(Buffer.from('${encoded}','base64')).toString())`
      if (Buffer.byteLength(guest) >= 128 * 1024)
        throw Error('Docker guest exceeds argv budget')
      await writeFile(asset, guest)
    }
  }
}
