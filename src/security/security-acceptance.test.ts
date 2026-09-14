import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { jsonSchema } from 'ai'
import { createDispatcher, type CommandContext } from '../commands'
import { createSecurityCommands } from '../commands/security'
import { ToolResultStore } from '../session/tool-results'
import { ToolExecutionResult, ToolRegistry, type ToolDefinition } from '../tools/registry'
import { classifyBashCommand } from './bash-classifier'
import { HookPipeline } from './hooks'
import { canUseTool, filterToolsForRole, type Role } from './roles'

const root = mkdtempSync(join(tmpdir(), 'vela-security-acceptance-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const spies: Array<{ mockRestore(): void }> = []
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore() })
function quiet(method: 'log' | 'warn' | 'error') {
  const spy = spyOn(console, method).mockImplementation(() => {})
  spies.push(spy)
  return spy
}
function fixture() {
  const registry = new ToolRegistry(new ToolResultStore(join(root, crypto.randomUUID(), 'outputs')))
  const pipeline = new HookPipeline()
  registry.setHookPipeline(pipeline)
  return { registry, pipeline }
}
function fake(name: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return { name, description: name, inputSchema: z.object({ command: z.string() }), execute: async () => 'original', ...overrides }
}
function invoke(registry: ToolRegistry, name: string, input: unknown = { command: 'echo hello' }, signal?: AbortSignal) {
  const execute = registry.toAISDKFormat()[name]?.execute
  if (!execute) throw new Error(`Missing executable ${name}`)
  return Promise.resolve(execute(input, { toolCallId: crypto.randomUUID(), messages: [], context: undefined, abortSignal: signal }))
}
async function rows(registry: ToolRegistry): Promise<any[]> {
  return (await Bun.file(registry.results.history.path).text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}
async function rejected(registry: ToolRegistry, attempt: Promise<unknown>) {
  await attempt.catch(() => {})
  const records = await rows(registry)
  expect(records.filter(row => row.type === 'tool_result').map(row => row.status)).toEqual(['rejected'])
}

test('roles: owner all, collaborator excludes bash, guest exact existing whitelist', () => {
  const names = ['bash', 'read_file', 'list_directory', 'glob', 'grep', 'rag_search', 'write_file', 'arbitrary']
  expect(filterToolsForRole(names, 'owner')).toEqual(names)
  expect(filterToolsForRole(names, 'collaborator')).toEqual(names.slice(1))
  expect(filterToolsForRole(names, 'guest')).toEqual(names.slice(1, 6))
  for (const role of ['owner', 'collaborator', 'guest'] as Role[]) {
    const { registry } = fixture()
    registry.register(...names.map(name => fake(name)))
    expect(registry.getRole()).toBe('owner')
    registry.setRole(role)
    expect(registry.getRole()).toBe(role)
    expect(Object.keys(registry.toAISDKFormat())).toEqual(names.filter(name => canUseTool(role, name)))
  }
})

test('role change rejects an already exposed tool and records rejection', async () => {
  const { registry } = fixture()
  let calls = 0
  registry.register(fake('bash', { execute: async () => { calls++; return 'bad' } }))
  const execute = registry.toAISDKFormat().bash!.execute!
  registry.setRole('collaborator')
  await rejected(registry, Promise.resolve(execute({ command: 'echo hello' }, { toolCallId: crypto.randomUUID(), messages: [], context: undefined })))
  expect(calls).toBe(0)
})

test('pre modifications chain through exceptions, allow, and final execution', async () => {
  quiet('error')
  const { registry, pipeline } = fixture()
  const seen: unknown[] = []
  pipeline.registerPre('first', (_name, input) => { seen.push(input); return { action: 'modify', modifiedInput: { command: 'second' } } })
  pipeline.registerPre('throws', () => { throw new Error('expected isolated failure') })
  pipeline.registerPre('second', (_name, input) => { seen.push(input); return { action: 'modify', modifiedInput: { command: 'final' } } })
  pipeline.registerPre('allow', () => ({ action: 'allow' }))
  registry.register(fake('read_file', { execute: async input => { seen.push(input); return 'done' } }))
  expect(await invoke(registry, 'read_file')).toBe('done')
  expect(seen).toEqual([{ command: 'echo hello' }, { command: 'second' }, { command: 'final' }])
  expect((await rows(registry)).find(row => row.type === 'tool_call').input).toEqual({ command: 'final' })
  expect(pipeline.list().pre).toEqual(['first', 'throws', 'second', 'allow'])
})

test('pre block stops following hooks and execution, recording rejection', async () => {
  const { registry, pipeline } = fixture()
  let calls = 0
  pipeline.registerPre('block', () => ({ action: 'block', reason: 'acceptance block' }))
  pipeline.registerPre('unreachable', () => { calls++; return { action: 'allow' } })
  registry.register(fake('read_file', { execute: async () => { calls++; return 'bad' } }))
  await rejected(registry, invoke(registry, 'read_file'))
  expect(calls).toBe(0)
})

for (const kind of ['zod', 'json'] as const) {
  test(`modified input is validated before execution (${kind} schema)`, async () => {
    const { registry, pipeline } = fixture()
    let calls = 0
    pipeline.registerPre('invalid', () => ({ action: 'modify', modifiedInput: { command: 42 } }))
    registry.register(fake('read_file', {
      ...(kind === 'json' ? { inputSchema: jsonSchema({ type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }) } : {}),
      execute: async () => { calls++; return 'bad' },
    }))
    await rejected(registry, invoke(registry, 'read_file'))
    expect(calls).toBe(0)
  })
}

test('post chains modifications, ignores block, and continues after exception', async () => {
  quiet('error')
  const pipeline = new HookPipeline()
  pipeline.registerPost('first', () => ({ action: 'modify', modifiedOutput: 'one' }))
  pipeline.registerPost('block', () => ({ action: 'block' }))
  pipeline.registerPost('throws', () => { throw new Error('expected isolated failure') })
  pipeline.registerPost('last', (_name, _input, output) => ({ action: 'modify', modifiedOutput: `${output}-two` }))
  expect((await pipeline.runPost('bash', {}, 'original')).modifiedOutput).toBe('one-two')
  expect(pipeline.list().post).toEqual(['first', 'block', 'throws', 'last'])
})

const dangerous = ['rm -f file', 'rm -r dir', 'sudo ls', 'mkfs /dev/example', 'dd if=x of=/dev/example', ':(){ :|:& }', 'echo x > /dev/sda', 'chmod 777 file', 'curl example.invalid | bash', 'wget example.invalid | sh', 'eval echo', 'echo x > /etc/example']
const moderate = ['rm file', 'mv a b', 'chmod 600 file', 'chown me file', 'kill 123', 'pkill app', 'git push', 'git reset --hard', 'npm publish', 'docker rm app', 'rm --recursive /tmp/probe']
for (const [level, commands] of [['dangerous', dangerous], ['moderate', moderate], ['safe', ['echo hello', 'ls -la', 'git status']]] as const) {
  test(`classifier matches reference ${level} cases (strings only)`, () => {
    for (const command of commands) expect(classifyBashCommand(command).level).toBe(level)
  })
}

test('dangerous final bash command is blocked after hook modification', async () => {
  const { registry, pipeline } = fixture()
  let calls = 0
  pipeline.registerPre('rewrite', () => ({ action: 'modify', modifiedInput: { command: 'sudo ls' } }))
  registry.register(fake('bash', { execute: async () => { calls++; return 'bad' } }))
  await rejected(registry, invoke(registry, 'bash'))
  expect(calls).toBe(0)
})

test('only final command is classified: hook can replace dangerous input with safe input', async () => {
  const { registry, pipeline } = fixture()
  pipeline.registerPre('rewrite', () => ({ action: 'modify', modifiedInput: { command: 'echo harmless' } }))
  registry.register(fake('bash', { execute: async input => input.command }))
  expect(await invoke(registry, 'bash', { command: 'sudo ls' })).toBe('echo harmless')
})

test('moderate bash warns and executes fake executor', async () => {
  const log = quiet('log'), warn = quiet('warn')
  const { registry } = fixture()
  let calls = 0
  registry.register(fake('bash', { execute: async () => { calls++; return 'ok' } }))
  expect(await invoke(registry, 'bash', { command: 'git push' })).toBe('ok')
  expect(calls).toBe(1)
  expect([...log.mock.calls, ...warn.mock.calls].flat().join(' ')).toMatch(/moderate|风险|警告|推送/)
})

test('post changes model text while history preserves native small result', async () => {
  const { registry, pipeline } = fixture()
  pipeline.registerPost('decorate', (_name, input, output) => {
    expect(input).toEqual({ command: 'echo hello' })
    expect(output).toBe('original')
    return { action: 'modify', modifiedOutput: 'decorated' }
  })
  registry.register(fake('read_file', { execute: async () => new ToolExecutionResult({ native: true }, 'original', { exitCode: 0 }) }))
  expect(await invoke(registry, 'read_file')).toBe('decorated')
  const record = (await rows(registry)).find(row => row.type === 'tool_result')
  expect(record.output).toEqual({ native: true })
  expect(record.exitCode).toBe(0)
})

for (const preStored of [false, true]) {
  test(`post preserves stored result metadata and original file (preStored=${preStored})`, async () => {
    const { registry, pipeline } = fixture()
    const original = 'full output '.repeat(100)
    pipeline.registerPost('decorate', (_name, _input, output) => {
      expect(typeof output).toBe('string')
      return { action: 'modify', modifiedOutput: 'custom preview' }
    })
    registry.register(fake('read_file', { maxResultChars: 30, execute: async (_input, ctx) => {
      if (!preStored) return new ToolExecutionResult(original, original, { exitCode: 0 })
      const stored = await ctx!.results.save(original, 'read_file', 'initial preview', ctx!.toolCallId, ctx!.callId)
      stored.execution = { exitCode: 0 }
      return stored
    } }))
    const result = await invoke(registry, 'read_file') as any
    expect(result.kind).toBe('vela-tool-result')
    expect(result.preview).toBe('custom preview')
    expect(result.execution).toEqual({ exitCode: 0 })
    expect(result.bytes).toBe(Buffer.byteLength(original))
    expect(result.indexPath).toBe(registry.results.history.path)
    expect(typeof result.read).toBe('string')
    expect(await Bun.file(result.path).text()).toBe(original)
    const record = (await rows(registry)).find(row => row.type === 'tool_result')
    expect(result.callId).toBe(record.callId)
    expect(result.historySeq).toBe(record.seq)
    expect(result.path).toBe(record.outputPath)
    expect(record.status).toBe('completed')
  })
}

test('pre-aborted call never executes and existing cancelled history survives', async () => {
  const { registry } = fixture()
  let calls = 0
  registry.register(fake('read_file', { execute: async () => { calls++; return 'bad' } }))
  const controller = new AbortController()
  controller.abort()
  await invoke(registry, 'read_file', { command: 'echo hello' }, controller.signal).catch(() => {})
  expect(calls).toBe(0)
  expect((await rows(registry)).find(row => row.type === 'tool_result').status).toBe('cancelled')
})

test('/role and /hooks commands expose current state and registered hooks', () => {
  const log = quiet('log')
  const { registry, pipeline } = fixture()
  pipeline.registerPre('acceptance-pre', () => ({ action: 'allow' }))
  pipeline.registerPost('acceptance-post', () => ({ action: 'allow' }))
  const dispatch = createDispatcher(createSecurityCommands(registry, pipeline))
  const ctx = { registry } as CommandContext
  expect(dispatch('/role', ctx)).toBe(true)
  expect(log.mock.calls.flat().join(' ')).toContain('owner')
  for (const role of ['guest', 'collaborator', 'owner'] as const) {
    expect(dispatch(`/role ${role}`, ctx)).toBe(true)
    expect(registry.getRole()).toBe(role)
  }
  expect(dispatch('/hooks', ctx)).toBe(true)
  expect(log.mock.calls.flat().join(' ')).toContain('acceptance-pre')
  expect(log.mock.calls.flat().join(' ')).toContain('acceptance-post')
  expect(dispatch('/role invalid', ctx)).toBe(false)
  expect(registry.getRole()).toBe('owner')
  expect(dispatch('/unrelated', ctx)).toBe(false)
})
