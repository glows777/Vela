/**
 * 生成公开 API 报告：`@glows777/vela` 和 `@glows777/vela/testing` 导出的每个名字和它的类型。
 * test/unit/public-api.test.ts 把它和 api/public-api.txt 比对；改公开面后运行
 * `bun run api:update` 更新快照，并在 PR 里能看到 API 的变化。
 * 带 `@internal` 的成员、private / protected 成员不算公开面。
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
      // 完整路径因机器而异，只保留模块里的名字
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
        // 只读的 getter 标成 get；有 setter 的和普通属性一样
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
      // 类型别名按源码写法输出（checker 只会给出别名本身的名字）
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
    if (!source) throw new Error(`找不到 ${file}`)
    const module = checker.getSymbolAtLocation(source)
    if (!module) throw new Error(`${file} 不是模块`)
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
  console.log(`已写入 ${path}`)
}
