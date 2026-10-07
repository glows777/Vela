import { expect, test } from 'bun:test'
import { join, relative, resolve } from 'node:path'

/**
 * core（src/ 下除 CLI 和测试工具以外的代码）是可以被别的项目 import 的 SDK：
 * 不写终端、不退出进程、不读环境变量、不碰 readline。输出走事件或注入的 logger。
 */
const SRC = resolve(import.meta.dir, '../../src')

/** 允许的地方：CLI、测试工具，以及第 1b 步会改写成内置扩展的模块 */
const ALLOWED = [
  'cli/',
  'testing/',
  // 1b：飞书 / supabase / web 改写成内置扩展，配置改由扩展 API 提供
  'plugins/built-in-plugins/',
  'channels/built-in-channels/',
  'tools/web.ts',
]

const FORBIDDEN: [RegExp, string][] = [
  [/\bconsole\.\w+/, 'console'],
  [/\bprocess\.(stdout|stderr)\b/, 'process.stdout/stderr'],
  [/\bprocess\.exit\b/, 'process.exit'],
  [/\bprocess\.env\b/, 'process.env'],
  [/['"]node:readline['"]/, 'node:readline'],
]

/** 去掉注释，避免说明文字里提到 process.env 之类被误报 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/(?! vela-boundary).*$/gm, '$1')
}

test('core modules do not write to the terminal, exit, read env or use readline', async () => {
  const violations: string[] = []
  for await (const file of new Bun.Glob('**/*.ts').scan(SRC)) {
    const path = file.replaceAll('\\', '/')
    if (ALLOWED.some((prefix) => path.startsWith(prefix))) continue
    const lines = stripComments(await Bun.file(join(SRC, file)).text()).split('\n')
    lines.forEach((line, i) => {
      if (lines[i - 1]?.includes('vela-boundary: allow')) return
      for (const [pattern, name] of FORBIDDEN)
        if (pattern.test(line))
          violations.push(`src/${path}:${i + 1} uses ${name}`)
    })
  }
  expect(violations).toEqual([])
})

test('the allow list only names paths that exist', async () => {
  for (const prefix of ALLOWED) {
    const glob = new Bun.Glob(prefix.endsWith('/') ? `${prefix}**` : prefix)
    const matches = await Array.fromAsync(glob.scan(SRC))
    expect(matches.length, relative(SRC, join(SRC, prefix))).toBeGreaterThan(0)
  }
})
