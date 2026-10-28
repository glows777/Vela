import { expect, test } from 'bun:test'
import {
  loadCliExtensions,
  parseArgs,
  selectTools,
} from '../../packages/vela/src/cli/setup.ts'

test('legacy command-line selectors name the canonical replacement', async () => {
  const messages: string[] = []
  await loadCliExtensions(
    {
      extensions: [{ name: 'feishu', builtin: true }],
      mcp: { servers: {} },
    } as Parameters<typeof loadCliExtensions>[0],
    parseArgs([]),
    (message) => messages.push(message),
  )
  expect(messages.join('\n')).toContain('builtin:feishu -> builtin:lark')
  expect(() =>
    selectTools(['lark_search_history'], {
      tools: ['feishu_*'],
      noTools: false,
      excludeTools: [],
    }),
  ).toThrow('feishu_* -> lark_*')
})
