/**
 * Single-package directory boundaries, AI SDK confinement, and lazy heavy-dependency gates.
 * Uses real manifests; knip owns declared-dependency checks.
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

/**
 * One-way layer DAG inside `packages/vela/src/<layer>/`.
 * Tightened further as S1a–S4 remove transitional layers (`legacy-channels`, old CLI direct calls).
 */
const LAYER_ALLOWED: Record<string, readonly string[]> = {
  shared: [],
  db: ['shared'],
  runtime: ['shared', 'db'],
  providers: ['shared'],
  driver: ['shared', 'db', 'providers'],
  mcp: ['shared', 'runtime', 'driver'],
  lark: ['shared', 'runtime', 'driver', 'legacy-channels'],
  'legacy-channels': ['shared', 'providers', 'driver'],
  config: ['shared', 'providers', 'driver', 'mcp', 'legacy-channels'],
  daemon: ['shared', 'db', 'runtime', 'providers', 'driver', 'mcp', 'lark'],
  cli: [
    'shared',
    'daemon',
    'providers',
    'driver',
    'mcp',
    'lark',
    'legacy-channels',
    'config',
    'testing',
  ],
  testing: [
    'shared',
    'db',
    'runtime',
    'providers',
    'driver',
    'legacy-channels',
  ],
}

/** Heavy packages must stay off the eager cold-start graph and confined to their owning layer. */
const HEAVY_OWNER: Record<string, string> = {
  '@larksuiteoapi/node-sdk': 'lark',
  '@modelcontextprotocol/sdk': 'mcp',
  '@earendil-works/pi-tui': 'cli',
  '@silvia-odwyer/photon-node': 'shared',
}
const HEAVY = new Set(Object.keys(HEAVY_OWNER))

/**
 * Shrink-only exact edge allowlist for files outside `src/providers/` (and `src/testing/`)
 * that still import `'ai'` / `'@ai-sdk/*'` until S1a replaces them with VelaMessage.
 * Each entry pins `type:<spec>` vs `runtime:<spec>` so adding a new package or turning a
 * type-only import into a runtime import fails immediately.
 */
const AI_SDK_S1A_ALLOWLIST: Record<string, readonly string[]> = {
  'packages/vela/src/cli/main.ts': ['type:ai'],
  'packages/vela/src/cli/tui/logs.ts': ['type:ai'],
  'packages/vela/src/driver/agent/cache.ts': [
    'type:@ai-sdk/provider',
    'type:ai',
  ],
  'packages/vela/src/driver/agent/checkpoint.ts': ['type:ai'],
  'packages/vela/src/driver/agent/events.ts': ['type:ai'],
  'packages/vela/src/driver/agent/index.ts': [
    'runtime:@ai-sdk/provider',
    'runtime:ai',
  ],
  'packages/vela/src/driver/agent/overflow.ts': ['runtime:@ai-sdk/provider'],
  'packages/vela/src/driver/agent/retry.ts': ['runtime:@ai-sdk/provider'],
  'packages/vela/src/driver/agent/step.ts': ['runtime:ai'],
  'packages/vela/src/driver/context/compressor.ts': ['runtime:ai'],
  'packages/vela/src/driver/context/request.ts': ['runtime:ai'],
  'packages/vela/src/driver/extensions/events.ts': ['type:@ai-sdk/provider'],
  'packages/vela/src/driver/extensions/memory/dream.ts': ['runtime:ai'],
  'packages/vela/src/driver/extensions/provider-hooks.ts': [
    'runtime:ai',
    'type:@ai-sdk/provider',
  ],
  'packages/vela/src/driver/extensions/runner.ts': ['type:@ai-sdk/provider'],
  'packages/vela/src/driver/messages.ts': ['type:ai'],
  'packages/vela/src/driver/session/defaults.ts': ['type:ai'],
  'packages/vela/src/driver/session/deps.ts': [
    'type:@ai-sdk/provider',
    'type:ai',
  ],
  'packages/vela/src/driver/session/export.ts': ['type:ai'],
  'packages/vela/src/driver/session/options.ts': ['type:ai'],
  'packages/vela/src/driver/session/resources.ts': ['type:ai'],
  'packages/vela/src/driver/tools/json-schema.ts': ['runtime:ai'],
  'packages/vela/src/driver/tools/registry.ts': ['runtime:ai', 'type:ai'],
  'packages/vela/src/driver/tools/sdk-tools.ts': ['runtime:ai'],
  'packages/vela/src/driver/tools/validation.ts': ['runtime:ai'],
  'packages/vela/src/driver/usage/tracker.ts': ['type:ai'],
  'packages/vela/src/driver/vela-session.ts': ['type:ai'],
  'packages/vela/src/driver/vela.ts': ['type:ai'],
  'packages/vela/src/mcp/tools.ts': ['runtime:ai'],
}

interface Package {
  name: string
  dir: string
  key: string
  exports: Record<string, { types?: string; import?: string }>
  manifest: Record<string, unknown>
}
interface Edge {
  spec: string
  lazy: boolean
  typeOnly: boolean
  at: ts.Node
}
const inside = (file: string, dir: string) =>
  file === dir || file.startsWith(dir + sep)

async function files(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, e.name)
    if (e.isDirectory()) found.push(...(await files(path)))
    else if (/\.[cm]?[jt]s$/.test(path)) found.push(path)
  }
  return found
}

const packageName = (spec: string) =>
  spec.startsWith('@')
    ? spec.split('/').slice(0, 2).join('/')
    : spec.split('/')[0]!

const isAiSdk = (spec: string) => {
  const name = packageName(spec)
  return name === 'ai' || name.startsWith('@ai-sdk/')
}

function layerOf(pkgDir: string, file: string): string | undefined {
  const rel = relative(join(pkgDir, 'src'), file).replaceAll('\\', '/')
  if (rel.startsWith('..') || !rel.includes('/')) return undefined
  return rel.split('/')[0]
}

function isDeferredImport(node: ts.Node): boolean {
  let cur = node.parent
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isGetAccessorDeclaration(cur) ||
      ts.isSetAccessorDeclaration(cur) ||
      ts.isConstructorDeclaration(cur) ||
      ts.isIfStatement(cur) ||
      ts.isConditionalExpression(cur) ||
      ts.isSwitchStatement(cur)
    )
      return true
    cur = cur.parent
  }
  return false
}

function edges(source: ts.SourceFile): Edge[] {
  const out: Edge[] = []
  const literal = (n: ts.Node | undefined) =>
    n && ts.isStringLiteralLike(n) ? n.text : undefined
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      const spec = literal(node.moduleSpecifier)
      let typeOnly = ts.isExportDeclaration(node) && !!node.isTypeOnly
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause
        typeOnly =
          !!clause?.isTypeOnly ||
          !!(
            clause &&
            !clause.name &&
            clause.namedBindings &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length &&
            clause.namedBindings.elements.every((e) => e.isTypeOnly)
          )
      }
      if (spec) out.push({ spec, lazy: false, typeOnly, at: node })
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      const spec = literal(node.argument.literal)
      if (spec) out.push({ spec, lazy: false, typeOnly: true, at: node })
    } else if (ts.isCallExpression(node)) {
      const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const requireCall =
        ts.isIdentifier(node.expression) && node.expression.text === 'require'
      const requireResolve =
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'resolve' &&
        node.expression.expression.getText(source) === 'require'
      if (dynamic || requireCall || requireResolve) {
        const spec = literal(node.arguments[0])
        out.push({
          spec: spec ?? '<nonliteral>',
          lazy: dynamic && isDeferredImport(node),
          typeOnly: false,
          at: node,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

export async function checkBoundaries(root: string): Promise<string[]> {
  root = resolve(root)
  const errors: string[] = []
  const packages: Package[] = []
  for (const entry of await readdir(join(root, 'packages'), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, 'packages', entry.name)
    let raw: string
    try {
      raw = await readFile(join(dir, 'package.json'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const manifest = JSON.parse(raw)
    packages.push({
      name: manifest.name,
      dir,
      key: entry.name,
      exports: manifest.exports ?? {},
      manifest,
    })
  }
  if (packages.length !== 1 || packages[0]!.key !== 'vela') {
    errors.push(
      `packages/: expected single published package "vela", found ${packages.map((p) => p.key).join(', ') || '(none)'}`,
    )
  }

  const publicPaths: Record<string, string[]> = {}
  for (const pkg of packages)
    for (const [subpath, entry] of Object.entries(pkg.exports)) {
      const target = entry.import ?? entry.types
      if (target)
        publicPaths[pkg.name + (subpath === '.' ? '' : subpath.slice(1))] = [
          './' +
            relative(
              root,
              resolve(
                pkg.dir,
                target
                  .replace('./dist/', 'src/')
                  .replace(/\.d\.ts$/, '.ts')
                  .replace(/\.js$/, '.ts'),
              ),
            ).replaceAll('\\', '/'),
        ]
    }
  const canonical = (paths: Record<string, unknown> = {}) =>
    JSON.stringify(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b)))
  const development =
    ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile).config
      ?.compilerOptions ?? {}
  if (
    development.baseUrl ||
    canonical(development.paths) !== canonical(publicPaths)
  )
    errors.push(
      'tsconfig.json: source aliases must equal the declared public export entries',
    )
  for (const file of [
    join(root, 'tsconfig.build.json'),
    ...packages.flatMap((p) => [
      join(p.dir, 'tsconfig.json'),
      join(p.dir, 'tsconfig.build.json'),
    ]),
  ]) {
    const config = ts.readConfigFile(file, ts.sys.readFile).config
      ?.compilerOptions
    if (config?.baseUrl || Object.keys(config?.paths ?? {}).length)
      errors.push(
        `${relative(root, file)}: source aliases may not bypass package exports`,
      )
    if (file === join(root, 'tsconfig.build.json') && config) {
      if (!config.paths || Object.keys(config.paths).length)
        errors.push(
          'tsconfig.build.json: builds must explicitly clear development paths',
        )
    }
  }

  const byName = new Map(packages.map((p) => [p.name, p]))
  const sourceMap = new Map<
    string,
    { pkg: Package; source: ts.SourceFile; edges: Edge[] }
  >()
  const report = (file: string, node: ts.Node | undefined, message: string) => {
    const at = node
      ? sourceMap
          .get(file)
          ?.source.getLineAndCharacterOfPosition(node.getStart()).line
      : undefined
    errors.push(
      `${relative(root, file).replaceAll('\\', '/')}${at === undefined ? '' : ':' + (at + 1)}: ${message}`,
    )
  }

  for (const pkg of packages) {
    for (const [subpath, conditions] of Object.entries(pkg.exports)) {
      if (subpath.includes('*'))
        report(
          join(pkg.dir, 'package.json'),
          undefined,
          `wildcard export ${subpath}`,
        )
      for (const target of Object.values(conditions))
        if (
          typeof target !== 'string' ||
          !target.startsWith('./dist/') ||
          target.includes('../')
        )
          report(
            join(pkg.dir, 'package.json'),
            undefined,
            `export ${subpath} escapes built artifacts`,
          )
    }
    for (const file of await files(join(pkg.dir, 'src'))) {
      const source = ts.createSourceFile(
        file,
        await readFile(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      )
      sourceMap.set(file, { pkg, source, edges: edges(source) })
    }
  }

  const sourceTarget = (pkg: Package, subpath: string) => {
    const entry = pkg.exports[subpath]
    const target = entry?.import ?? entry?.types
    return target
      ? resolve(
          pkg.dir,
          target
            .replace(/^\.\/dist\//, 'src/')
            .replace(/\.d\.ts$/, '.ts')
            .replace(/\.js$/, '.ts'),
        )
      : undefined
  }

  const eagerTargets = new Map<string, string[]>()
  const seenAiAllowlist = new Set<string>()

  for (const [file, record] of sourceMap) {
    const { pkg, edges: imports } = record
    const localRel = relative(root, file).replaceAll('\\', '/')
    const srcLayer = layerOf(pkg.dir, file)
    const eager: string[] = []
    const builtin = /[\\/]driver[\\/]extensions[\\/](memory|web)[\\/]/.test(
      file,
    )
    const builtinDir = builtin
      ? file.slice(0, file.indexOf(`${sep}extensions${sep}`)) +
        `${sep}extensions${sep}` +
        file.split(`${sep}extensions${sep}`)[1]!.split(sep)[0]
      : ''

    for (const edge of imports) {
      const { spec } = edge
      if (spec === '<nonliteral>') {
        if (localRel !== 'packages/vela/src/driver/config/extensions.ts')
          report(file, edge.at, 'unreviewed nonliteral module loader')
        continue
      }
      let destination: string | undefined
      if (spec.startsWith('/') || spec.startsWith('file:')) {
        report(file, edge.at, `source escape ${spec}`)
        continue
      }
      if (spec.startsWith('.')) {
        destination = resolve(dirname(file), spec)
        if (!inside(destination, pkg.dir))
          report(file, edge.at, `source escape ${spec}`)
        if (!/\.[jt]s$/.test(destination)) destination += '.ts'
      } else {
        const name = packageName(spec)
        const target = byName.get(name)
        if (target) {
          const subpath = spec === name ? '.' : '.' + spec.slice(name.length)
          destination = sourceTarget(target, subpath)
          if (!destination)
            report(file, edge.at, `private or missing export ${spec}`)
        }
        // Gate 2: AI SDK confinement to src/providers/ (+ src/testing/ + shrink-only S1a exact edge allowlist)
        if (isAiSdk(spec)) {
          const edgeKey = `${edge.typeOnly ? 'type' : 'runtime'}:${spec}`
          if (srcLayer === 'providers' || srcLayer === 'testing') {
            // allowed
          } else if (AI_SDK_S1A_ALLOWLIST[localRel]?.includes(edgeKey)) {
            seenAiAllowlist.add(`${localRel}#${edgeKey}`)
          } else {
            report(
              file,
              edge.at,
              `AI SDK import "${edgeKey}" is confined to src/providers/`,
            )
          }
        }
        // Gate 3a: Heavy dependency layer ownership & Photon lazy rule
        if (HEAVY.has(name)) {
          const owner = HEAVY_OWNER[name]
          if (srcLayer !== owner && srcLayer !== 'testing')
            report(
              file,
              edge.at,
              `heavy dependency ${name} is confined to src/${owner}/`,
            )
          if (
            name === '@silvia-odwyer/photon-node' &&
            !edge.lazy &&
            !edge.typeOnly
          )
            report(file, edge.at, 'Photon must remain lazy')
        }
      }

      // Gate 1: One-way layer DAG inside packages/vela/src/ (and block root barrel bypasses)
      if (destination && sourceMap.has(destination)) {
        const dstLayer = layerOf(pkg.dir, destination)
        if (srcLayer && !dstLayer) {
          const dstBase = relative(
            join(pkg.dir, 'src'),
            destination,
          ).replaceAll('\\', '/')
          const canUseDriver =
            srcLayer === 'driver' ||
            (LAYER_ALLOWED[srcLayer]?.includes('driver') ?? false)
          const allowedRoot =
            (dstBase === 'extension-api.ts' && canUseDriver) ||
            ((srcLayer === 'cli' || srcLayer === 'testing') &&
              (dstBase === 'vela.ts' || dstBase === 'settings.ts'))
          if (!allowedRoot)
            report(
              file,
              edge.at,
              `layer ${srcLayer} may not import root barrel ${dstBase} (${spec})`,
            )
        } else if (
          srcLayer &&
          dstLayer &&
          srcLayer !== dstLayer &&
          srcLayer in LAYER_ALLOWED
        ) {
          const allowed = LAYER_ALLOWED[srcLayer]!
          if (!allowed.includes(dstLayer))
            report(
              file,
              edge.at,
              `layer direction ${srcLayer} -> ${dstLayer} is forbidden (${spec})`,
            )
        }
        if (!edge.lazy && !edge.typeOnly) eager.push(destination)
      }

      if (builtin) {
        const publicAPI = resolve(pkg.dir, 'src/extension-api.ts')
        const driverAPI = resolve(pkg.dir, 'src/driver/extension-api.ts')
        const local =
          destination &&
          (inside(destination, builtinDir) ||
            destination === publicAPI ||
            destination === driverAPI ||
            (file ===
              resolve(pkg.dir, 'src/driver/extensions/memory/dream.ts') &&
              destination === resolve(pkg.dir, 'src/driver/usage/tracker.ts')))
        if (destination && !local)
          report(
            file,
            edge.at,
            `light builtin must use its own files or extension-api: ${spec}`,
          )
      }
    }
    eagerTargets.set(file, eager)
  }

  // Gate 3b: Cold-start graph check — no eager runtime edge to any heavy package from `.`, `./extension-api`, or `cli/main.ts`
  const vela = byName.get('@glows777/vela')
  if (vela) {
    const coldEntries: [string, string | undefined][] = [
      ['@glows777/vela', sourceTarget(vela, '.')],
      ['@glows777/vela/extension-api', sourceTarget(vela, './extension-api')],
      ['cli/main.ts', resolve(vela.dir, 'src/cli/main.ts')],
    ]
    for (const [label, entry] of coldEntries) {
      if (!entry || !sourceMap.has(entry)) continue
      const visited = new Set<string>()
      const visit = (file: string) => {
        if (visited.has(file)) return
        visited.add(file)
        const record = sourceMap.get(file)
        if (!record) return
        for (const edge of record.edges) {
          if (edge.lazy || edge.typeOnly) continue
          const name = packageName(edge.spec)
          if (HEAVY.has(name))
            report(
              file,
              edge.at,
              `heavy dependency ${name} eagerly reachable from ${label}`,
            )
        }
        for (const next of eagerTargets.get(file) ?? []) visit(next)
      }
      visit(entry)
    }
  }

  // Resolve symbols only for the virtual light-built-in boundary; own implementation members are allowed.
  const builtinFiles = [...sourceMap.keys()].filter((file) =>
    /[\\/]driver[\\/]extensions[\\/](memory|web)[\\/]/.test(file),
  )
  if (builtinFiles.length) {
    const program = ts.createProgram([...sourceMap.keys()], {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      baseUrl: root,
      paths: publicPaths,
    })
    const checker = program.getTypeChecker()
    for (const file of builtinFiles) {
      const record = sourceMap.get(file)!
      const source = program.getSourceFile(file)
      if (!source) continue
      const visit = (node: ts.Node) => {
        if (
          ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node)
        ) {
          const member = ts.isPropertyAccessExpression(node)
            ? node.name.text
            : node.argumentExpression &&
                ts.isStringLiteralLike(node.argumentExpression)
              ? node.argumentExpression.text
              : undefined
          const symbol = member
            ? checker.getPropertyOfType(
                checker.getTypeAtLocation(node.expression),
                member,
              )
            : undefined
          if (
            !(
              file ===
                resolve(
                  record.pkg.dir,
                  'src/driver/extensions/memory/dream.ts',
                ) && member === 'tracker'
            ) &&
            symbol?.declarations?.some((d) =>
              ts.getJSDocTags(d).some((t) => t.tagName.text === 'internal'),
            )
          )
            report(
              file,
              undefined,
              `light builtin accesses internal member ${member}`,
            )
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }

  return [...new Set(errors)].sort()
}

if (import.meta.main) {
  const failures = await checkBoundaries(resolve(import.meta.dir, '..'))
  if (failures.length) {
    console.error(failures.join('\n'))
    process.exitCode = 1
  } else console.log('package boundaries and lightweight entry graphs: ok')
}
