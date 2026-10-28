/** Package ownership and entry costs, using real manifests; knip owns declared-dependency checks. */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const allowed: Record<string, readonly string[]> = {
  core: [],
  channels: ['core'],
  mcp: ['core'],
  rag: ['core'],
  lark: ['core', 'channels'],
  vela: ['core', 'channels', 'mcp', 'rag', 'lark'],
}
const heavy = new Set([
  '@larksuiteoapi/node-sdk',
  '@modelcontextprotocol/sdk',
  'sqlite-vec',
  '@earendil-works/pi-tui',
])
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
          lazy: dynamic,
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
    const manifest = JSON.parse(
      await readFile(join(dir, 'package.json'), 'utf8'),
    )
    packages.push({
      name: manifest.name,
      dir,
      key: entry.name,
      exports: manifest.exports ?? {},
      manifest,
    })
  }
  for (const file of [
    join(root, 'tsconfig.json'),
    ...packages.flatMap((p) => [
      join(p.dir, 'tsconfig.json'),
      join(p.dir, 'tsconfig.build.json'),
    ]),
  ]) {
    const config = ts.readConfigFile(file, ts.sys.readFile)
    if (
      config.config?.compilerOptions?.paths ||
      config.config?.compilerOptions?.baseUrl
    )
      errors.push(
        `${relative(root, file)}: source aliases may not bypass package exports`,
      )
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
      `${relative(root, file)}${at === undefined ? '' : ':' + (at + 1)}: ${message}`,
    )
  }
  for (const pkg of packages) {
    for (const field of [
      'dependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const name of Object.keys((pkg.manifest[field] ?? {}) as object)) {
        const target = byName.get(name)
        if (target && !(allowed[pkg.key] ?? []).includes(target.key))
          report(
            join(pkg.dir, 'package.json'),
            undefined,
            `package direction ${pkg.key} -> ${target.key}`,
          )
        if ((pkg.key === 'core' || pkg.key === 'channels') && heavy.has(name))
          report(
            join(pkg.dir, 'package.json'),
            undefined,
            `heavy dependency ${name} in lightweight ${pkg.key}`,
          )
      }
    }
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
  const targets = new Map<string, string[]>()
  for (const [file, record] of sourceMap) {
    const { pkg, edges: imports } = record
    const localTargets: string[] = []
    const builtin =
      /[\\/]extensions[\\/](memory|web|permission-gate)[\\/]/.test(file) &&
      pkg.key === 'core'
    const builtinDir = builtin
      ? file.slice(0, file.indexOf(`${sep}extensions${sep}`)) +
        `${sep}extensions${sep}` +
        file.split(`${sep}extensions${sep}`)[1]!.split(sep)[0]
      : ''
    for (const edge of imports) {
      const { spec } = edge
      if (spec === '<nonliteral>') {
        // Existing user-extension loading and the Node/Bun SQLite adapter are intentional nonliteral loaders.
        const local = relative(root, file).replaceAll('\\', '/')
        if (
          ![
            'packages/core/src/config/extensions.ts',
            'packages/rag/src/sqlite.ts',
          ].includes(local)
        )
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
          if (target !== pkg && !(allowed[pkg.key] ?? []).includes(target.key))
            report(
              file,
              edge.at,
              `package direction ${pkg.key} -> ${target.key}`,
            )
        }
        if ((pkg.key === 'core' || pkg.key === 'channels') && heavy.has(name))
          report(file, edge.at, `heavy entry edge ${spec}`)
        if (
          name === '@silvia-odwyer/photon-node' &&
          !edge.lazy &&
          !edge.typeOnly
        )
          report(file, edge.at, 'Photon must remain lazy')
      }
      if (builtin) {
        const publicAPI = resolve(pkg.dir, 'src/extension-api.ts')
        const local =
          destination &&
          (inside(destination, builtinDir) || destination === publicAPI)
        // External declared dependencies are checked by knip; core-owned access has only this public entry.
        if (destination && !local)
          report(
            file,
            edge.at,
            `light builtin must use its own files or extension-api: ${spec}`,
          )
      }
      if (destination && sourceMap.has(destination))
        localTargets.push(destination)
    }
    targets.set(file, localTargets)
  }
  // Follow each public core/channels entry across package exports, including type and lazy edges.
  for (const pkg of packages.filter(
    (p) => p.key === 'core' || p.key === 'channels',
  )) {
    for (const subpath of Object.keys(pkg.exports)) {
      const entry = sourceTarget(pkg, subpath)
      const visited = new Set<string>()
      const visit = (file: string) => {
        if (visited.has(file)) return
        visited.add(file)
        const record = sourceMap.get(file)
        if (!record) return
        for (const edge of record.edges)
          if (heavy.has(packageName(edge.spec)))
            report(
              file,
              edge.at,
              `heavy dependency reachable from ${pkg.name}${subpath === '.' ? '' : subpath.slice(1)}`,
            )
        for (const target of targets.get(file) ?? []) visit(target)
      }
      if (entry) visit(entry)
    }
  }
  // Resolve symbols only for the virtual light-built-in boundary; own implementation members are allowed.
  const program = ts.createProgram([...sourceMap.keys()], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
  })
  const checker = program.getTypeChecker()
  for (const [file, record] of sourceMap) {
    if (
      record.pkg.key !== 'core' ||
      !/[\\/]extensions[\\/](memory|web|permission-gate)[\\/]/.test(file)
    )
      continue
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
  return [...new Set(errors)].sort()
}
if (import.meta.main) {
  const failures = await checkBoundaries(resolve(import.meta.dir, '..'))
  if (failures.length) {
    console.error(failures.join('\n'))
    process.exitCode = 1
  } else console.log('package boundaries and lightweight entry graphs: ok')
}
