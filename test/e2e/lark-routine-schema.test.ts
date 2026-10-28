import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadModels } from '@glows777/vela-core'
import { lark } from '@glows777/vela-lark'
import { fakeLark, larkEvent } from '../support/lark.ts'
import { responsesReply } from '../support/responses.ts'
import { RoutineClock } from '../support/routine-clock.ts'
import { cleanupTestVelas, createTestVela, tempDir } from '../support/vela.ts'

const realFetch = globalThis.fetch
const dirs: { cleanup(): void }[] = []
afterEach(async () => {
  await cleanupTestVelas()
  globalThis.fetch = realFetch
  for (const dir of dirs.splice(0)) dir.cleanup()
})

test('the real Responses request exports an object-root routine schema and can create a reminder', async () => {
  const dir = tempDir('vela-routine-schema-')
  dirs.push(dir)
  writeFileSync(
    join(dir.path, 'models.json'),
    JSON.stringify({
      providers: {
        compat: {
          api: 'openai-responses',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'test',
        },
      },
    }),
  )
  const requests: {
    tools?: { name: string; parameters: { type?: string } }[]
  }[] = []
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    requests.push(body)
    const parameters = body.tools?.find(
      (tool: { name: string }) => tool.name === 'lark_routines',
    )?.parameters
    // Match the real provider's rejection at the actual SDK request boundary.
    if (parameters?.type !== 'object')
      return Response.json(
        {
          error: {
            message: `Invalid schema for function 'lark_routines': schema must be a JSON Schema of 'type: "object"', got 'type: ${parameters?.type ?? 'null'}'.`,
            type: 'invalid_request_error',
            code: 'invalid_function_parameters',
          },
        },
        { status: 400 },
      )
    return responsesReply(
      body,
      undefined,
      requests.length === 1
        ? {
            name: 'lark_routines',
            arguments: JSON.stringify({
              action: 'create',
              message: 'Review the PR',
              schedule: { at: '2026-01-05T09:00' },
            }),
          }
        : undefined,
    )
  }) as typeof fetch
  const fake = fakeLark()
  const t = createTestVela({
    cwd: dir.path,
    providers: loadModels({ agentDir: dir.path }),
    model: 'compat/deepseek-flash',
    extensionConfig: { lark: { timezone: 'UTC' } },
    extensions: [
      lark({
        owners: ['ou_alice'],
        chats: [{ id: 'oc_group', tools: [] }],
        transport: fake.transport,
      }),
    ],
  })
  t.internals.gateway.routines.clock = new RoutineClock()
  await t.vela.startChannels()
  fake.deliver(
    larkEvent({
      root_id: 'root',
      thread_id: 'thread',
      content: '{"text":"Remind this topic at 09:00 to review the PR"}',
    }),
  )
  const deadline = Date.now() + 5000
  while (!fake.sent.length) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for the provider-backed channel reply')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  expect(fake.sent.at(-1)?.text).toBe('<at user_id="ou_alice"></at> OK')
  expect(requests).toHaveLength(2)
  for (const request of requests)
    expect(
      request.tools?.find((tool) => tool.name === 'lark_routines')?.parameters
        .type,
    ).toBe('object')
  expect(t.eventsOf('tool_execution_end')).toContainEqual(
    expect.objectContaining({ toolName: 'lark_routines', isError: false }),
  )
  expect(t.internals.gateway.routines.list('lark', 'oc_group')).toMatchObject([
    {
      message: 'Review the PR',
      creator: { id: 'ou_alice' },
      schedule: { at: '2026-01-05T09:00:00.000Z' },
    },
  ])
}, 10000)
