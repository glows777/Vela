import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'zod'
import { openDatabase } from '../../../../src/db/index.ts'
import { agentLoop } from '../../../../src/driver/agent/index.ts'
import { SessionStore } from '../../../../src/driver/session/index.ts'
import { ToolRegistry } from '../../../../src/driver/tools/registry.ts'
import { TokenTracker } from '../../../../src/driver/usage/tracker.ts'
import { VelaDriver } from '../../../../src/driver/vela-driver.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../../../src/testing/core/faux.ts'

const dir = mkdtempSync(join(tmpdir(), 'vela-agent-cancel-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('agent cancellation reaches the tool, waits for its durable result, and never starts another model step', async () => {
  const db = openDatabase({ path: ':memory:' })
  const store = new SessionStore('cancel', db, { ephemeral: true })
  const registry = new ToolRegistry(join(dir, 'outputs'))
  const controller = new AbortController()
  let receivedSignal = false
  registry.register({
    name: 'wait',
    description: 'wait',
    inputSchema: z.object({}),
    execute: async (_input, context) => {
      receivedSignal = !!context?.signal
      return new Promise<string>((resolve) => {
        const fallback = setTimeout(() => resolve('not cancelled'), 300)
        context?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(fallback)
            resolve('cancelled tool output')
          },
          { once: true },
        )
        controller.abort(new Error('test cancellation'))
      })
    },
  })
  const model = createFauxModel({
    responses: [fauxToolCall('wait', {}), fauxText('done')],
  })
  const driver = new VelaDriver({
    sessionId: 'cancel',
    db,
    store,
    registry,
    tracker: new TokenTracker(),
  })
  try {
    await expect(
      driver.run({
        model,
        systemPrompt: '',
        messages: [{ role: 'user', content: 'wait' }],
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow('test cancellation')
    expect(receivedSignal).toBe(true)
    expect(model.calls).toHaveLength(1)
    const rows = db.all<{ status: string; preview: string | null }>(
      'SELECT status, preview FROM vela_tool_calls WHERE session_id = ?',
      'cancel',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      status: 'failed',
      preview: 'Operation aborted',
    })
  } finally {
    db.close()
  }
})

test('the main request refreshes the history guide after context preparation', async () => {
  let instructions = 'OLD_LIVE_PATH'
  const model = createFauxModel({
    responses: [
      (req) => {
        expect(req.system).toContain('NEW_FROZEN_PATH')
        expect(req.system).not.toContain('OLD_LIVE_PATH')
        return fauxText('done')
      },
    ],
  })
  await agentLoop({
    model,
    systemPrompt: () => instructions,
    toolRegistry: new ToolRegistry(),
    messages: [{ role: 'user', content: 'check' }],
    tokenTracker: new TokenTracker(),
    prepareContext: async () => {
      instructions = 'NEW_FROZEN_PATH'
    },
  })
  expect(model.calls).toHaveLength(1)
})
