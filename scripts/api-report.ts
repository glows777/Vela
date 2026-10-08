/**
 * Generates the public API report: every name exported from `@glows777/vela` and
 * `@glows777/vela/testing`, with its type. test/unit/public-api.test.ts compares it
 * with api/public-api.txt; after changing the public surface, run `bun run api:update`
 * to refresh the snapshot so the API change shows up in the PR.
 * `@internal`, private and protected members are not part of the public surface.
 */
import { join, resolve } from 'node:path'
import ts from 'typescript'

const ROOT = resolve(import.meta.dir, '..')
const ENTRIES: [string, string][] = [
  ['@glows777/vela', 'src/index.ts'],
  ['@glows777/vela/testing', 'src/testing/index.ts'],
]
const FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseFullyQualifiedType |
  ts.TypeFormatFlags.WriteArrowStyleSignature

export function apiReport(): string {
  const config = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile)
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT)
  const files = ENTRIES.map(([, file]) => join(ROOT, file))
  const program = ts.createProgram(files, { ...options, noEmit: true })
  const checker = program.getTypeChecker()

  const typeText = (type: ts.Type, at?: ts.Node) =>
    checker
      .typeToString(type, at, FLAGS)
      // Full paths differ per machine; keep only the name inside the module
      .replace(/import\("[^"]*"\)\./g, '')

  const isInternal = (symbol: ts.Symbol) =>
    symbol.declarations?.some(
      (d) =>
        ts.getJSDocTags(d).some((tag) => tag.tagName.text === 'internal') ||
        (ts.getCombinedModifierFlags(d as ts.Declaration) &
          (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !==
          0 ||
        (ts.isPropertyDeclaration(d) || ts.isMethodDeclaration(d)
          ? ts.isPrivateIdentifier(d.name)
          : false),
    ) ?? false

  const members = (type: ts.Type, at: ts.Node): string[] =>
    checker
      .getPropertiesOfType(type)
      .filter((p) => !isInternal(p))
      .map((p) => {
        const decl = p.valueDeclaration ?? p.declarations?.[0]
        const readonly =
          decl &&
          ts.getCombinedModifierFlags(decl as ts.Declaration) &
            ts.ModifierFlags.Readonly
            ? 'readonly '
            : ''
        // Read-only getters are marked `get`; ones with a setter print like plain properties
        const accessor =
          p.flags & ts.SymbolFlags.GetAccessor &&
          !(p.flags & ts.SymbolFlags.SetAccessor)
            ? 'get '
            : ''
        const optional = p.flags & ts.SymbolFlags.Optional ? '?' : ''
        return `    ${readonly}${accessor}${p.name}${optional}: ${typeText(checker.getTypeOfSymbolAtLocation(p, decl ?? at), decl ?? at)}`
      })
      .sort()

  const describe = (name: string, symbol: ts.Symbol): string[] => {
    const target =
      symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol
    const decl = target.declarations?.[0]
    if (!decl) return [`  ${name}: ?`]
    if (ts.isClassDeclaration(decl)) {
      const instance = checker.getDeclaredTypeOfSymbol(target)
      return [`  class ${name}`, ...members(instance, decl)]
    }
    if (ts.isInterfaceDeclaration(decl)) {
      const type = checker.getDeclaredTypeOfSymbol(target)
      return [`  interface ${name}`, ...members(type, decl)]
    }
    if (ts.isTypeAliasDeclaration(decl)) {
      // Print type aliases as written in source (the checker would only give the alias name)
      const params = decl.typeParameters
        ? `<${decl.typeParameters.map((p) => p.getText()).join(', ')}>`
        : ''
      const body = decl.type
        .getText()
        .replace(/\/\*\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n      ')
      return [`  type ${name}${params} = ${body}`]
    }
    const type = checker.getTypeOfSymbolAtLocation(target, decl)
    return [
      `  ${ts.isFunctionDeclaration(decl) ? 'function' : 'const'} ${name}: ${typeText(type, decl)}`,
    ]
  }

  const out: string[] = []
  for (const [entry, file] of ENTRIES) {
    const source = program.getSourceFile(join(ROOT, file))
    if (!source) throw new Error(`Cannot find ${file}`)
    const module = checker.getSymbolAtLocation(source)
    if (!module) throw new Error(`${file} is not a module`)
    out.push(`# ${entry}`, '')
    for (const symbol of checker
      .getExportsOfModule(module)
      .sort((a, b) => a.name.localeCompare(b.name)))
      out.push(...describe(symbol.name, symbol))
    out.push('')
  }
  return out.join('\n')
}

if (import.meta.main) {
  const path = join(ROOT, 'api/public-api.txt')
  await Bun.write(path, apiReport())
  console.log(`Wrote ${path}`)
}
