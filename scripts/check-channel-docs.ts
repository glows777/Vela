import { join, relative, resolve, sep } from 'node:path'
import { Glob } from 'bun'
import ts from 'typescript'

const SOURCES = [
  { dir: 'packages/channels/src', extension: 'channel' },
  { dir: 'packages/lark/src', extension: 'lark' },
] as const

export const CHANNEL_DOC_ALLOWLIST: ReadonlySet<string> = new Set()

const HINT =
  'Document it in docs/channels.md in the same change as the CHANGELOG entry, or add the exposed name to CHANNEL_DOC_ALLOWLIST when a person or model cannot see it.'

export type ChannelToolRef = { name: string; at: string }

export function exposedToolName(extension: string, registered: string): string {
  return registered === extension || registered.startsWith(`${extension}_`)
    ? registered
    : `${extension}_${registered}`
}

function isRegisterTool(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === 'registerTool'
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === 'registerTool'
  )
}

function nameText(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name)
    ? name.text
    : undefined
}

export function channelToolsInSource(
  file: string,
  text: string,
  extension: string,
): ChannelToolRef[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const refs: ChannelToolRef[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isRegisterTool(node.expression))
      refs.push(toolRef(source, file, node, extension))
    ts.forEachChild(node, visit)
  }
  visit(source)
  return refs
}

function toolRef(
  source: ts.SourceFile,
  file: string,
  node: ts.CallExpression,
  extension: string,
): ChannelToolRef {
  const at = (pos: number) =>
    `${file}:${source.getLineAndCharacterOfPosition(pos).line + 1}`
  const arg = node.arguments[0]
  if (!arg || !ts.isObjectLiteralExpression(arg))
    throw new Error(
      `${at(node.getStart(source))}: registerTool needs an object literal with a string name`,
    )
  const nameProp = arg.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && nameText(property.name) === 'name',
  )
  if (!nameProp || !ts.isStringLiteral(nameProp.initializer))
    throw new Error(
      `${at((nameProp ?? node).getStart(source))}: registerTool name must be a string literal`,
    )
  return {
    name: exposedToolName(extension, nameProp.initializer.text),
    at: at(nameProp.getStart(source)),
  }
}

function mentioned(guide: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`).test(guide)
}

export function missingChannelTools(
  refs: readonly ChannelToolRef[],
  guide: string,
  allowlist: ReadonlySet<string> = CHANNEL_DOC_ALLOWLIST,
): string[] {
  const missing = refs.filter(
    (ref) => !allowlist.has(ref.name) && !mentioned(guide, ref.name),
  )
  if (missing.length === 0) return []
  return [
    ...missing.map(
      (ref) => `${ref.name} (${ref.at}) is not in docs/channels.md`,
    ),
    HINT,
  ]
}

export async function checkChannelDocs(root: string): Promise<string[]> {
  try {
    const refs: ChannelToolRef[] = []
    for (const source of SOURCES) {
      const dir = join(root, source.dir)
      for await (const file of new Glob('**/*.ts').scan(dir)) {
        const path = join(dir, file)
        refs.push(
          ...channelToolsInSource(
            relative(root, path).split(sep).join('/'),
            await Bun.file(path).text(),
            source.extension,
          ),
        )
      }
    }
    return missingChannelTools(
      refs,
      await Bun.file(join(root, 'docs/channels.md')).text(),
    )
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)]
  }
}

if (import.meta.main) {
  const missing = await checkChannelDocs(resolve(import.meta.dir, '..'))
  if (missing.length === 0) {
    console.log('channel guide: registered tools are documented')
  } else {
    for (const line of missing) console.error(line)
    process.exit(1)
  }
}
