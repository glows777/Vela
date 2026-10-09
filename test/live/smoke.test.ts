import { afterEach, expect, test } from 'bun:test'
import { createOpenAI } from '@ai-sdk/openai'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

// Real-model smoke test: runs only with VELA_LIVE=1 and OPENAI_API_KEY / OPENAI_API_MODEL_NAME set (bun run test:live)
const live =
  process.env.VELA_LIVE === '1' &&
  !!process.env.OPENAI_API_KEY &&
  !!process.env.OPENAI_API_MODEL_NAME

afterEach(cleanupTestVelas)

const realModel = () =>
  createOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_API_BASE_URL,
  }).chat(process.env.OPENAI_API_MODEL_NAME!)

test.skipIf(!live)(
  'a real model answers and the turn completes',
  async () => {
    const t = createTestVela({
      model: realModel(),
      limits: { retryBaseMs: 500 },
    })
    await t.run('Reply with exactly one word: hello')
    expect(t.eventsOf('agent_end').at(-1)).toMatchObject({
      type: 'agent_end',
      reason: 'done',
    })
    expect(t.lastAssistantText().length).toBeGreaterThan(0)
  },
  60_000,
)

test.skipIf(!live)(
  'a real model can call read_file in the temp cwd',
  async () => {
    const t = createTestVela({
      model: realModel(),
      files: { 'secret.txt': 'the code word is PINEAPPLE' },
      limits: { retryBaseMs: 500 },
    })
    await t.run(
      'Use read_file to read secret.txt, then reply with only the code word in it',
    )
    expect(t.eventsOf('tool_call').map((e) => e.toolName)).toContain(
      'read_file',
    )
    expect(t.lastAssistantText()).toContain('PINEAPPLE')
  },
  120_000,
)
