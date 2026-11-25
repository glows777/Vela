import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { openDatabase } from '../../../../src/db/index.ts'
import type { ModelMessage } from '../../../../src/driver/messages.ts'
import { SessionStore } from '../../../../src/driver/session/index.ts'
import { ToolRegistry } from '../../../../src/driver/tools/registry.ts'
import { TokenTracker } from '../../../../src/driver/usage/tracker.ts'
import { VelaDriver } from '../../../../src/driver/vela-driver.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../../../src/testing/core/faux.ts'

const dir = mkdtempSync(join(tmpdir(), 'vela-agent-checkpoint-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('TX1 commits assistant message and pending vela_tool_calls before any tool side effect', async () => {
  const db = openDatabase({ path: ':memory:' })
  const store = new SessionStore('tx1', db, { ephemeral: true })
  let executions = 0
  const registry = new ToolRegistry(join(dir, 'tx1-tools'))
  registry.register({
    name: 'write',
    description: 'write marker',
    inputSchema: z.object({}),
    execute: async () => {
      const msgRows = db.all<{ kind: string; role: string | null }>(
        'SELECT kind, role FROM vela_messages WHERE session_id = ? ORDER BY seq ASC',
        'tx1',
      )
      expect(msgRows.at(-1)?.role).toBe('assistant')
      const callRows = db.all<{ tool_name: string; status: string }>(
        'SELECT tool_name, status FROM vela_tool_calls WHERE session_id = ?',
        'tx1',
      )
      expect(callRows).toEqual([{ tool_name: 'write', status: 'running' }])
      executions++
      return 'saved'
    },
  })
  const messages: ModelMessage[] = [{ role: 'user', content: 'work' }]
  store.ensureSessionRow()
  store.appendMessage(messages[0]!)
  const driver = new VelaDriver({
    sessionId: 'tx1',
    db,
    store,
    registry,
    tracker: new TokenTracker(),
  })
  try {
    await driver.run({
      model: createFauxModel({
        responses: [fauxToolCall('write', {}), fauxText('done')],
      }),
      systemPrompt: '',
      messages,
    })
    expect(executions).toBe(1)
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
  } finally {
    db.close()
  }
})

test('cancellation after TX1 pairs pending calls with aborted results without duplicating the assistant', async () => {
  const db = openDatabase({ path: ':memory:' })
  const store = new SessionStore('cancel-tx1', db, { ephemeral: true })
  const controller = new AbortController()
  const registry = new ToolRegistry(join(dir, 'cancel-tools'))
  registry.register({
    name: 'wait',
    description: 'wait',
    inputSchema: z.object({}),
    execute: async () => {
      controller.abort(new Error('abort mid tool'))
      return 'late'
    },
  })
  const messages: ModelMessage[] = [{ role: 'user', content: 'work' }]
  store.ensureSessionRow()
  store.appendMessage(messages[0]!)
  const driver = new VelaDriver({
    sessionId: 'cancel-tx1',
    db,
    store,
    registry,
    tracker: new TokenTracker(),
  })
  try {
    await expect(
      driver.run({
        model: createFauxModel({ responses: [fauxToolCall('wait', {})] }),
        systemPrompt: '',
        messages,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow('abort mid tool')
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
  } finally {
    db.close()
  }
})
