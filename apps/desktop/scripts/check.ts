import { builtinModules } from 'node:module'
import { relative, resolve } from 'node:path'
import { Glob } from 'bun'
import ts from 'typescript'

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
const roles = {
  main: ['main', 'shared', 'assets', 'design'],
  preload: ['preload', 'shared'],
  renderer: ['renderer', 'shared', 'assets', 'styles', 'design'],
  shared: ['shared'],
}
type Role = keyof typeof roles
const roleOf = (path: string): Role | undefined =>
  (['main', 'preload', 'renderer', 'shared'] satisfies Role[]).find((role) =>
    path.startsWith(`src/${role}/`),
  )
const config = ts.readConfigFile(
  resolve(root, 'tsconfig.json'),
  ts.sys.readFile,
)
const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
for await (const path of new Glob('src/**/*.{ts,tsx}').scan(root)) {
  if (path === 'src/forge-env.d.ts') continue
  const role = roleOf(path)
  if (!role) throw new Error(`Source has no process owner: ${path}`)
  const source = await Bun.file(resolve(root, path)).text()
  for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
    const name = imported.fileName
    if (name === 'bun' || name.startsWith('bun:'))
      throw new Error(`${path} imports unsupported runtime ${name}`)
    if (name.startsWith('@glows777/vela')) {
      if (role !== 'main')
        throw new Error(
          `${path} imports SDK ${name}; only main may host the SDK`,
        )
      continue
    }
    if (
      (role === 'renderer' || role === 'shared') &&
      (forbidden.has(name) ||
        name.startsWith('node:') ||
        name.startsWith('electron/'))
    )
      throw new Error(`${path} imports privileged module ${name}`)
    let destination = ts.resolveModuleName(
      name,
      resolve(root, path),
      options,
      ts.sys,
    ).resolvedModule?.resolvedFileName
    if (!destination && name.startsWith('.'))
      destination = resolve(root, path, '..', name)
    else if (!destination && name.startsWith('@/'))
      destination = resolve(root, 'src/renderer', name.slice(2))
    else if (!destination && name.startsWith('/'))
      destination = resolve(root, `.${name}`)
    if (destination) {
      const target = relative(root, destination)
      if (target.split('/').includes('node_modules')) continue
      if (
        !roles[role].some((owner) =>
          target.startsWith(owner === 'design' ? 'design/' : `src/${owner}/`),
        )
      )
        throw new Error(
          `${path} imports outside ${role} ownership: ${name} resolves to ${target}`,
        )
    }
  }
}
console.log('Desktop token and process ownership boundaries pass.')
console.log(
  `Bun ${Bun.version}; Node ${process.versions.node}; ${process.platform}/${process.arch}`,
)
