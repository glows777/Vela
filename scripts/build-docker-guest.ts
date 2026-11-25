import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const GUEST_ENTRYPOINT = resolve(
  import.meta.dir,
  '../packages/vela/src/driver/execution/docker-guest.ts',
)

/** Bundle the container guest (`guest.cjs`) transported over Docker argv. */
export async function buildDockerGuest(outdir: string) {
  await mkdir(outdir, { recursive: true })
  const built = await Bun.build({
    entrypoints: [GUEST_ENTRYPOINT],
    target: 'node',
    format: 'cjs',
    outdir,
    naming: 'guest.cjs',
  })
  if (!built.success)
    throw new AggregateError(built.logs, 'Docker guest build failed')
  // Linux limits each exec argument to 128 KiB. Transport the bundled, trusted guest
  // (including the existing YAML parser) in one argv entry on every supported host.
  const asset = join(outdir, 'guest.cjs')
  const encoded = gzipSync(await readFile(asset)).toString('base64')
  const guest = `require('node:vm').runInThisContext(require('node:zlib').gunzipSync(Buffer.from('${encoded}','base64')).toString())`
  if (Buffer.byteLength(guest) >= 128 * 1024)
    throw Error('Docker guest exceeds argv budget')
  await writeFile(asset, guest)
}
