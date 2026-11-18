/** Host primitives are confined to the local adapter and these existing host-side helpers. */
import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { Glob } from 'bun'
import ts from 'typescript'

const hostHelpers: Record<string, readonly string[]> = {
  // Public host resource loaders, including Vela's own installed documentation.
  'packages/core/src/prompt/context-files.ts': ['fs'],
  'packages/core/src/prompt/templates.ts': ['fs'],
  'packages/core/src/prompt/index.ts': ['fs'],
  'packages/core/src/skills/loader.ts': ['fs'],
  'packages/core/src/tools/binaries.ts': ['fs', 'child_process'],
  'packages/core/src/tools/process-tree.ts': ['child_process'],
}

/** Reject direct host filesystem/process dependencies in execution-facing code. */
export async function checkExecutionBoundaries(
  root: string,
): Promise<string[]> {
  const paths: string[] = []
  for (const pattern of [
    'packages/core/src/tools/**/*.ts',
    'packages/core/src/prompt/**/*.ts',
    'packages/core/src/skills/**/*.ts',
    'packages/core/src/extensions/background/**/*.ts',
    'packages/core/src/session/user-bash.ts',
    'packages/core/src/context/compressor.ts',
    'packages/channels/src/attachments.ts',
  ]) {
    for await (const path of new Glob(pattern).scan(root))
      paths.push(join(root, path))
  }
  const errors: string[] = []
  for (const file of paths) {
    const path = relative(root, file).replaceAll('\\', '/')
    const source = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    const check = (node: ts.Node, name: string) => {
      const match = /^(?:node:)?(fs|child_process)(?:\/|$)/.exec(name)
      if (!match || hostHelpers[path]?.includes(match[1]!)) return
      const { line } = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      )
      errors.push(
        `${path}:${line + 1}: direct ${name} import bypasses ExecutionEnv`,
      )
    }
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      )
        check(node, node.moduleSpecifier.text)
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'require'))
      ) {
        const arg = node.arguments[0]
        if (arg && ts.isStringLiteralLike(arg)) check(node, arg.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return errors
}
