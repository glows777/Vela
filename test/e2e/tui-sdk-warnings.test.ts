import { afterEach, expect, spyOn, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionAPI } from '@glows777/vela-core'
import { defineJsonSchemaTool, loadModels } from '@glows777/vela-core'
import { jsonSchema } from 'ai'
import { responsesReply } from '../support/responses.ts'
import { startTui, stopTuis } from '../support/terminal.ts'
import { cleanupTestVelas, createTestVela, tempDir } from '../support/vela.ts'

const realFetch = globalThis.fetch
const dirs: { cleanup(): void }[] = []
afterEach(async () => {
  await stopTuis()
  await cleanupTestVelas()
  globalThis.fetch = realFetch
  for (const dir of dirs.splice(0)) dir.cleanup()
})

/** The real OpenAI Responses adapter over offline HTTP; it reports JSON Schema compatibility warnings. */
function fixture() {
  const dir = tempDir('vela-sdk-warnings-')
  dirs.push(dir)
  writeFileSync(
    join(dir.path, 'models.json'),
    JSON.stringify({
      providers: {
        compat: {
          api: 'openai-responses',
          baseUrl: 'https://gateway.example/v1',
          apiKey: 'test',
          models: [{ id: 'deepseek-flash' }],
        },
      },
    }),
  )
  const requests: Record<string, unknown>[] = []
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    requests.push(body)
    return responsesReply(body)
  }) as typeof fetch
  return {
    cwd: dir.path,
    providers: loadModels({ agentDir: dir.path }),
    requests,
  }
}

/** What an MCP server built with Zod 3 publishes: record keys constrained by propertyNames. */
function records(vela: ExtensionAPI) {
  vela.registerTool(
    defineJsonSchemaTool({
      name: 'records_read',
      description: 'Read records',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          notes: {
            type: 'object',
            propertyNames: { type: 'string', minLength: 1 },
            additionalProperties: { type: 'string' },
          },
        },
        required: ['notes'],
        additionalProperties: false,
      }),
      execute: async () => ({ ok: true }),
    }),
  )
}

const warning =
  'The feature "JSON Schema propertyNames" is used in a compatibility mode.'

test('interactive mode shows an AI SDK compatibility warning as a notice, not on stderr', async () => {
  const f = fixture()
  const t = createTestVela({
    ...f,
    model: 'compat/deepseek-flash',
    extensions: [records],
  })
  const emitWarning = spyOn(process, 'emitWarning')
  const tui = await startTui(t.vela)
  await tui.started
  tui.submit('Read the records')
  await tui.until('AI SDK Warning')
  expect(tui.screen()).toContain('propertyNames')
  expect(tui.screen()).toContain('compatibility mode')
  expect(
    emitWarning.mock.calls.map((call) => String(call[0])).join('\n'),
  ).not.toContain(warning)
  emitWarning.mockRestore()
})

test('the same warning is shown once per interactive session', async () => {
  const f = fixture()
  const t = createTestVela({
    ...f,
    model: 'compat/deepseek-flash',
    extensions: [records],
  })
  const tui = await startTui(t.vela)
  await tui.started
  tui.submit('First')
  await tui.until(() => t.eventsOf('agent_end').length === 1)
  tui.submit('Second')
  await tui.until(() => t.eventsOf('agent_end').length === 2)
  expect(f.requests).toHaveLength(2)
  expect(tui.screen().match(/AI SDK Warning/g)?.length).toBe(1)
})

test('the SDK warning logger is restored when interactive mode shuts down', async () => {
  const f = fixture()
  const t = createTestVela({ ...f, model: 'compat/deepseek-flash' })
  const before = globalThis.AI_SDK_LOG_WARNINGS
  const tui = await startTui(t.vela)
  await tui.started
  expect(globalThis.AI_SDK_LOG_WARNINGS).toBeFunction()
  await tui.mode.shutdown()
  expect(globalThis.AI_SDK_LOG_WARNINGS).toBe(before)
})

test('outside interactive mode the SDK keeps logging warnings through process.emitWarning', async () => {
  const f = fixture()
  const t = createTestVela({
    ...f,
    model: 'compat/deepseek-flash',
    extensions: [records],
  })
  const emitWarning = spyOn(process, 'emitWarning').mockImplementation(() => {})
  await t.run('Read the records')
  expect(
    emitWarning.mock.calls.map((call) => String(call[0])).join('\n'),
  ).toContain(warning)
  emitWarning.mockRestore()
})
