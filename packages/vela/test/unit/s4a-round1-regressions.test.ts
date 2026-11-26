import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../../src/runtime-sdk.ts'
import type { VelaRuntime } from '../../src/runtime-sdk-types.ts'
import { createFauxModel, fauxText } from '../../src/testing/core/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

function makeTempDir(prefix = 'vela-s4a-r1-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await Promise.resolve(fn()).catch(() => {})
  }
})

test('ephemeralSessions preserves owner config, auth.json, and memory without writing vela.db', async () => {
  const agentDir = makeTempDir('vela-r1-ephem-agent-')
  const cwd = makeTempDir('vela-r1-ephem-cwd-')
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({ model: 'openai/gpt-4o' }),
  )
  writeFileSync(
    join(agentDir, 'auth.json'),
    JSON.stringify({ openai: { type: 'api_key', key: 'sk-ephem' } }),
  )

  const runtime = createRuntime({ agentDir, ephemeralSessions: true })
  cleanups.push(() => runtime.dispose())

  const models = await runtime.models()
  expect(models.some((m) => m.ref === 'openai/gpt-4o')).toBe(true)
  const s = await runtime.sessions.create({
    id: 'ephem-s1',
    location: { environment: 'local', cwd },
  })
  const snap = await runtime.sessions.inspect(s.id)
  expect(snap.persistence).toEqual({ type: 'memory' })
  expect(snap.modelInfo?.ref).toBe('openai/gpt-4o')
  expect(existsSync(join(agentDir, 'vela.db'))).toBe(false)
})

test('approveLocation scopes --approve strictly to the approved cwd and isolates resumed sessions', async () => {
  const agentDir = makeTempDir('vela-r1-trust-agent-')
  const dirA = makeTempDir('vela-r1-trust-a-')
  const dirB = makeTempDir('vela-r1-trust-b-')
  mkdirSync(join(dirB, '.vela'), { recursive: true })
  writeFileSync(join(dirB, '.vela/SYSTEM.md'), 'SECRET_B_SYSTEM')

  const runtime = createRuntime({ agentDir, defaultModel: 'mock' })
  cleanups.push(() => runtime.dispose())

  const s = await runtime.sessions.create({
    id: 'sess-b',
    location: { environment: 'local', cwd: dirB },
  })
  await runtime.sessions.configure(s.id, {
    cwd: dirA,
    approve: true,
    approveLocation: dirA,
  })
  const snap = await runtime.sessions.inspect(s.id, { previewPrompt: true })
  expect(snap.cwd).toBe(dirB)
  expect(snap.resources.trusted).toBe(false)
  expect(snap.promptSnapshot?.systemPrompt).not.toContain('SECRET_B_SYSTEM')
})

test('trusted project config narrows owner tools via mergeDefaultTools and supplies fallback model', async () => {
  const agentDir = makeTempDir('vela-r1-proj-agent-')
  const projDir = makeTempDir('vela-r1-proj-cwd-')
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({ tools: ['read', 'bash'] }),
  )
  mkdirSync(join(projDir, '.vela'), { recursive: true })
  writeFileSync(
    join(projDir, '.vela/config.json'),
    JSON.stringify({
      tools: ['read'],
      providers: {},
      model: 'local/p',
    }),
  )

  const runtime = createRuntime({
    agentDir,
    trustOverride: () => true,
    providers: {
      local: {
        models: [{ id: 'p', name: 'p' }],
        createModel: () => createFauxModel({ responses: [fauxText('ok')] }),
      },
    },
  })
  cleanups.push(() => runtime.dispose())

  const s = await runtime.sessions.create({
    id: 'proj-s1',
    location: { environment: 'local', cwd: projDir },
  })
  const snap = await runtime.sessions.inspect(s.id)
  expect(snap.activeTools).toEqual(['read'])
  expect(snap.modelInfo?.ref).toBe('local/p')
})

test('--no-extensions disables built-ins while explicit -e builtin:memory re-enables memory only', async () => {
  const agentDir = makeTempDir('vela-r1-noext-agent-')
  const cwd = makeTempDir('vela-r1-noext-cwd-')
  const runtime = createRuntime({ agentDir, defaultModel: 'mock' })
  cleanups.push(() => runtime.dispose())

  const s1 = await runtime.sessions.create({
    id: 'noext-1',
    location: { environment: 'local', cwd },
  })
  await runtime.sessions.configure(s1.id, { cwd, noExtensions: true })
  const snap1 = await runtime.sessions.inspect(s1.id)
  expect(snap1.activeTools).not.toContain('memory')
  expect(snap1.activeTools).not.toContain('todo')
  expect(snap1.activeTools).not.toContain('background_status')

  await runtime.sessions.configure(s1.id, {
    cwd,
    noExtensions: true,
    extensions: ['builtin:memory'],
  })
  const snap2 = await runtime.sessions.inspect(s1.id)
  expect(snap2.activeTools).toContain('memory')
  expect(snap2.activeTools).not.toContain('todo')
})

test('extension factories are cached per session and dispatch session_start / session_shutdown', async () => {
  const agentDir = makeTempDir('vela-r1-cache-agent-')
  const cwd = makeTempDir('vela-r1-cache-cwd-')
  const marker = join(cwd, 'lifecycle.log')
  const extPath = join(cwd, 'ext.ts')
  writeFileSync(
    extPath,
    `import { appendFileSync } from 'node:fs'
export default function ext(vela) {
  appendFileSync(${JSON.stringify(marker)}, 'factory\\n')
  vela.on('session_start', () => appendFileSync(${JSON.stringify(marker)}, 'start\\n'))
  vela.on('session_shutdown', () => appendFileSync(${JSON.stringify(marker)}, 'shutdown\\n'))
}
`,
  )

  const runtime = createRuntime({ agentDir, defaultModel: 'mock' })
  cleanups.push(() => runtime.dispose())

  const s = await runtime.sessions.create({
    id: 'cache-s1',
    location: { environment: 'local', cwd },
  })
  await runtime.sessions.configure(s.id, { cwd, extensions: [extPath] })
  await runtime.sessions.inspect(s.id)
  await runtime.sessions.inspect(s.id)
  await runtime.sessions.runCommand(s.id, '/tasks')
  await runtime.prompt(s.id, { text: 'hello' })
  await runtime.waitForIdle(s.id)
  await runtime.sessions.delete(s.id)

  const events = (await Bun.file(marker).text()).trim().split('\n')
  expect(events).toEqual(['factory', 'start', 'shutdown'])
})

test('!! excludeFromContext is ignored by Ctrl+B detach and stale specialModels clear on real model switch', async () => {
  const agentDir = makeTempDir('vela-r1-ctrlb-agent-')
  const cwd = makeTempDir('vela-r1-ctrlb-cwd-')
  const runtime: VelaRuntime = createRuntime({
    agentDir,
    providers: {
      real: {
        models: [{ id: 'm', name: 'm' }],
        createModel: () =>
          createFauxModel({ responses: [fauxText('real-reply')] }),
      },
    },
  })
  cleanups.push(() => runtime.dispose())

  const s = await runtime.sessions.create({
    id: 'ctrlb-s1',
    location: { environment: 'local', cwd },
  })
  // /tasks works before first turn or bash
  expect(await runtime.sessions.runCommand(s.id, '/tasks')).toEqual({
    handled: true,
  })

  // excludeFromContext !! command cannot be detached into background
  const bashPromise = runtime.sessions.execBash(s.id, 'sleep 0.3 && echo hi', {
    excludeFromContext: true,
  })
  await new Promise((r) => setTimeout(r, 30))
  const detached = await runtime.jobs.promoteForeground(s.id)
  expect(detached).toEqual([])
  await bashPromise

  // Mock -> real model configure replaces stale specialModel
  await runtime.sessions.configure(s.id, { cwd, model: 'mock' })
  await runtime.sessions.configure(s.id, { cwd, model: 'real/m' })
  const snap = await runtime.sessions.inspect(s.id)
  expect(snap.modelInfo?.ref).toBe('real/m')
})
