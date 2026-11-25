import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'zod'
import { openDatabase } from '../../../../src/db/index.ts'
import { ToolExecutionResult } from '../../../../src/driver/index.ts'
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
import { createTestBashTool } from '../../../support/bash.ts'

const root = mkdtempSync(join(tmpdir(), 'vela-tool-history-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test('VelaDriver persists TX2a before execute and completes with inline result', async () => {
  const db = openDatabase({ path: ':memory:' })
  try {
    const store = new SessionStore('small', db, { ephemeral: true })
    const registry = new ToolRegistry(join(root, 'small'))
    const input = { command: 'example', content: '😀'.repeat(500) }
    registry.register({
      name: 'inspect',
      description: '',
      inputSchema: z.object({ command: z.string(), content: z.string() }),
      execute: async () => {
        const row = db.get<{
          status: string
          attempt: number
          input_json: string
        }>(
          'SELECT status, attempt, input_json FROM vela_tool_calls WHERE session_id = ?',
          'small',
        )
        expect(row?.status).toBe('running')
        expect(row?.attempt).toBe(1)
        expect(JSON.parse(row!.input_json)).toEqual(input)
        return { ok: true, value: 42 }
      },
    })
    const driver = new VelaDriver({
      sessionId: 'small',
      db,
      store,
      registry,
      tracker: new TokenTracker(),
    })
    const messages: ModelMessage[] = [{ role: 'user', content: 'run' }]
    store.ensureSessionRow()
    store.appendMessage(messages[0]!)
    await driver.run({
      model: createFauxModel({
        responses: [fauxToolCall('inspect', input), fauxText('done')],
      }),
      systemPrompt: '',
      messages,
    })
    const row = db.get<{ status: string; is_error: number; preview: string }>(
      'SELECT status, is_error, preview FROM vela_tool_calls WHERE session_id = ?',
      'small',
    )
    expect(row).toMatchObject({ status: 'completed', is_error: 0 })
    expect(JSON.parse(row!.preview)).toEqual({ ok: true, value: 42 })
  } finally {
    db.close()
  }
})

test('native MCP errors and thrown errors are recorded in vela_tool_calls', async () => {
  const db = openDatabase({ path: ':memory:' })
  try {
    const store = new SessionStore('errors', db, { ephemeral: true })
    const registry = new ToolRegistry(join(root, 'errors'))
    const native = {
      isError: true,
      content: [{ type: 'text', text: 'remote problem' }],
      structuredContent: { reason: 7 },
    }
    registry.register(
      {
        name: 'mcp',
        description: '',
        inputSchema: z.object({}),
        execute: async () =>
          new ToolExecutionResult(native, 'remote problem', { isError: true }),
      },
      {
        name: 'throw',
        description: '',
        inputSchema: z.object({}),
        execute: async () => {
          throw new Error('explicit failure')
        },
      },
    )
    const driver = new VelaDriver({
      sessionId: 'errors',
      db,
      store,
      registry,
      tracker: new TokenTracker(),
    })
    const messages: ModelMessage[] = [{ role: 'user', content: 'run' }]
    store.ensureSessionRow()
    store.appendMessage(messages[0]!)
    await driver.run({
      model: createFauxModel({
        responses: [
          [fauxToolCall('mcp', {}), fauxToolCall('throw', {})],
          fauxText('done'),
        ],
      }),
      systemPrompt: '',
      messages,
    })
    const rows = db.all<{
      tool_name: string
      status: string
      is_error: number
      preview: string
    }>(
      'SELECT tool_name, status, is_error, preview FROM vela_tool_calls WHERE session_id = ? ORDER BY call_index ASC',
      'errors',
    )
    expect(rows).toEqual([
      {
        tool_name: 'mcp',
        status: 'failed',
        is_error: 1,
        preview: 'remote problem',
      },
      {
        tool_name: 'throw',
        status: 'failed',
        is_error: 1,
        preview: 'explicit failure',
      },
    ])
  } finally {
    db.close()
  }
})

test('rejected unknown tool calls are captured as failed rows by VelaDriver', async () => {
  const db = openDatabase({ path: ':memory:' })
  try {
    const store = new SessionStore('rejected', db, { ephemeral: true })
    const registry = new ToolRegistry(join(root, 'rejected'))
    registry.register({
      name: 'known',
      description: 'known',
      inputSchema: z.object({}),
      execute: async () => 'ok',
    })
    const driver = new VelaDriver({
      sessionId: 'rejected',
      db,
      store,
      registry,
      tracker: new TokenTracker(),
    })
    const messages: ModelMessage[] = [{ role: 'user', content: 'test' }]
    store.ensureSessionRow()
    store.appendMessage(messages[0]!)
    await driver.run({
      model: createFauxModel({
        responses: [
          fauxToolCall(
            'missing_tool',
            { important: 123 },
            { id: 'invalid-sdk' },
          ),
          fauxText('done'),
        ],
      }),
      systemPrompt: '',
      messages,
    })
    const row = db.get<{
      tool_name: string
      status: string
      is_error: number
      input_json: string
    }>(
      'SELECT tool_name, status, is_error, input_json FROM vela_tool_calls WHERE session_id = ?',
      'rejected',
    )
    expect(row).toMatchObject({
      tool_name: 'missing_tool',
      status: 'failed',
      is_error: 1,
    })
    expect(JSON.parse(row!.input_json)).toEqual({ important: 123 })
  } finally {
    db.close()
  }
})

test('Bash cancellation persists aborted output in vela_tool_calls', async () => {
  const db = openDatabase({ path: ':memory:' })
  try {
    const store = new SessionStore('cancel', db, { ephemeral: true })
    const registry = new ToolRegistry(join(root, 'cancel'))
    registry.register(createTestBashTool(root))
    const abort = new AbortController()
    const driver = new VelaDriver({
      sessionId: 'cancel',
      db,
      store,
      registry,
      tracker: new TokenTracker(),
    })
    const messages: ModelMessage[] = [{ role: 'user', content: 'run' }]
    store.ensureSessionRow()
    store.appendMessage(messages[0]!)
    const pending = driver.run({
      model: createFauxModel({
        responses: [
          fauxToolCall('bash', {
            command: "printf 'BEFORE_CANCEL\\n'; touch ready; sleep 30 & wait",
          }),
        ],
      }),
      systemPrompt: '',
      messages,
      abortSignal: abort.signal,
    })
    const deadline = Date.now() + 3000
    while (
      !(await Bun.file(join(root, 'ready')).exists()) &&
      Date.now() < deadline
    )
      await Bun.sleep(10)
    expect(await Bun.file(join(root, 'ready')).exists()).toBe(true)
    abort.abort()
    await expect(pending).rejects.toBeDefined()
    const row = db.get<{ status: string; is_error: number; preview: string }>(
      'SELECT status, is_error, preview FROM vela_tool_calls WHERE session_id = ?',
      'cancel',
    )
    expect(row?.is_error).toBe(1)
    expect(row?.preview).toContain('BEFORE_CANCEL')
  } finally {
    db.close()
  }
})
