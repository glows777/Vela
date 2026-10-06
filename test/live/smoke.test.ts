import { afterEach, expect, test } from 'bun:test'
import { createOpenAI } from '@ai-sdk/openai'
import { cleanupTestVelas, createTestVela } from '../support/vela'

// 真实模型冒烟测试：只在 VELA_LIVE=1 且配置了 OPENAI_API_KEY / OPENAI_API_MODEL_NAME 时运行（bun run test:live）
const live =
  process.env.VELA_LIVE === '1' && !!process.env.OPENAI_API_KEY && !!process.env.OPENAI_API_MODEL_NAME

afterEach(cleanupTestVelas)

const realModel = () =>
  createOpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_API_BASE_URL }).chat(
    process.env.OPENAI_API_MODEL_NAME!,
  )

test.skipIf(!live)('a real model answers and the turn completes', async () => {
  const t = createTestVela({ model: realModel(), limits: { retryBaseMs: 500 } })
  await t.run('只回复两个字：你好')
  expect(t.events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'done' })
  expect(t.lastAssistantText().length).toBeGreaterThan(0)
}, 60_000)

test.skipIf(!live)('a real model can call read_file in the temp cwd', async () => {
  const t = createTestVela({
    model: realModel(),
    files: { 'secret.txt': 'the code word is PINEAPPLE' },
    limits: { retryBaseMs: 500 },
  })
  await t.run('用 read_file 读 secret.txt，然后只回复里面的暗号')
  expect(t.eventsOf('tool_call').map((e) => e.toolName)).toContain('read_file')
  expect(t.lastAssistantText()).toContain('PINEAPPLE')
}, 120_000)
