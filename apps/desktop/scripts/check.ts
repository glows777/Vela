import { createHash } from 'node:crypto'
import { builtinModules } from 'node:module'
import { relative, resolve } from 'node:path'
import { Glob } from 'bun'
import ts from 'typescript'
import provenance from '../design/provenance.json'

const root = resolve(import.meta.dir, '..')
const foundation = await Bun.file(
  resolve(root, 'src/renderer/components/arc/foundation.css'),
).text()
const arcVariables = new Set(
  [...foundation.matchAll(/--[a-z][a-z0-9-]*/g)].map((match) => match[0]),
)
for await (const path of new Glob('src/styles/**/*.css').scan(root)) {
  const source = await Bun.file(resolve(root, path)).text()
  for (const match of source.matchAll(/(--[\w-]+)\s*:/g)) {
    const name = match[1]!
    if (name.startsWith('--vela-')) continue
    if (path === 'src/styles/arc-theme.css' && arcVariables.has(name)) continue
    throw new Error(
      `Unprefixed Vela token ${name} in ${path}. Use --vela-*; Arc overrides belong in arc-theme.css.`,
    )
  }
}
const forbidden = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  'electron',
])
for await (const path of new Glob('src/**/*.{ts,tsx}').scan(root)) {
  const source = await Bun.file(resolve(root, path)).text()
  for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
    const name = imported.fileName
    if (name.startsWith('@glows777/vela') || name.startsWith('bun:'))
      throw new Error(`${path} imports deferred runtime ${name}`)
    if (!path.startsWith('src/renderer/')) continue
    if (forbidden.has(name))
      throw new Error(`${path} imports privileged module ${name}`)
    let destination: string | undefined
    if (name.startsWith('.')) destination = resolve(root, path, '..', name)
    else if (name.startsWith('@/'))
      destination = resolve(root, 'src/renderer', name.slice(2))
    else if (name.startsWith('/')) destination = resolve(root, `.${name}`)
    if (destination) {
      const target = relative(root, destination)
      if (
        !['src/renderer/', 'src/assets/', 'src/styles/', 'design/'].some(
          (prefix) => target.startsWith(prefix),
        )
      )
        throw new Error(
          `${path} imports outside the renderer's app boundary: ${name}`,
        )
    }
  }
}
for (const asset of provenance.assets) {
  const digest = createHash('sha256')
    .update(
      new Uint8Array(await Bun.file(resolve(root, asset.path)).arrayBuffer()),
    )
    .digest('hex')
  if (digest !== asset.sha256)
    throw new Error(`Asset hash mismatch: ${asset.path}`)
}
for (const file of provenance.arc.items.flatMap((item) => item.files)) {
  const digest = createHash('sha256')
    .update(await Bun.file(resolve(root, file.path)).text())
    .digest('hex')
  if (digest !== file.adoptedSha256)
    throw new Error(
      `Arc source drift: ${file.path}. Review upstream changes and update provenance.`,
    )
}
const arcLicense = createHash('sha256')
  .update(await Bun.file(resolve(root, provenance.arc.licensePath)).text())
  .digest('hex')
if (arcLicense !== provenance.arc.licenseSha256)
  throw new Error('Arc license hash mismatch')
console.log(
  `Desktop boundaries, ${provenance.assets.length} assets, and 11 adopted Arc source hashes match.`,
)
console.log(
  `Bun ${Bun.version}; Node ${process.versions.node}; ${process.platform}/${process.arch}`,
)
