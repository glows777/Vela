import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureCliProject } from '../../src/cli/runtime-client.ts'
import { createRuntime } from '../../src/runtime-sdk.ts'
import type { VelaRuntime } from '../../src/runtime-sdk-types.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../src/testing/core/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

function makeTempDir(prefix = 'vela-s4a-r2-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await Promise.resolve(fn()).catch(() => {})
  }
})

async function runTextTurn(
  runtime: VelaRuntime,
  sessionId: string,
  text: string,
): Promise<{ status: string; error?: string }> {
  let terminal: { status: string; error?: string } | undefined
  const unsub = runtime.events.subscribe((ev) => {
    if (ev.sessionId === sessionId && ev.type === 'run_finished') {
      terminal = { status: ev.status, error: ev.error }
    }
  })
  try {
    await runtime.prompt(sessionId, { text })
    await runtime.waitForIdle(sessionId)
    return terminal ?? { status: 'missing' }
  } finally {
    unsub()
  }
}

test('revoking project trust invalidates cached session resources and runner immediately', async () => {
  const agentDir = makeTempDir('vela-r2-revoketrust-agent-')
  const cwd = makeTempDir('vela-r2-revoketrust-cwd-')
  mkdirSync(join(cwd, '.vela'), { recursive: true })
  writeFileSync(join(cwd, '.vela', 'SYSTEM.md'), 'TRUSTED_WORKSPACE_PROMPT')

  const runtime = createRuntime({
    agentDir,
    defaultModel: createFauxModel({ responses: [fauxText('ok')] }),
  })
  cleanups.push(() => runtime.dispose())

  await runtime.trust.approve({ environment: 'local', cwd }, true)
  const s = await runtime.sessions.create({
    id: 'trust-revoke-1',
    location: { environment: 'local', cwd },
  })
  const trustedSnap = await runtime.sessions.inspect(s.id, {
    previewPrompt: true,
  })
  expect(trustedSnap.resources.trusted).toBe(true)
  expect(trustedSnap.promptSnapshot?.systemPrompt).toContain(
    'TRUSTED_WORKSPACE_PROMPT',
  )

  await runtime.trust.approve({ environment: 'local', cwd }, false)
  const revokedSnap = await runtime.sessions.inspect(s.id, {
    previewPrompt: true,
  })
  expect(revokedSnap.resources.trusted).toBe(false)
  expect(revokedSnap.promptSnapshot?.systemPrompt).not.toContain(
    'TRUSTED_WORKSPACE_PROMPT',
  )
})

test('inline image attachments enforce session ownership via readOwnedBytes', async () => {
  const agentDir = makeTempDir('vela-r2-blob-agent-')
  const cwd = makeTempDir('vela-r2-blob-cwd-')
  const runtime = createRuntime({
    agentDir,
    defaultModel: createFauxModel({ responses: [fauxText('should-not-run')] }),
  })
  cleanups.push(() => runtime.dispose())

  const s1 = await runtime.sessions.create({
    id: 'blob-s1',
    location: { environment: 'local', cwd },
  })
  const s2 = await runtime.sessions.create({
    id: 'blob-s2',
    location: { environment: 'local', cwd },
  })
  const blob = await runtime.blobs.storeInbound({
    sessionId: s1.id,
    filename: 'secret.png',
    mimeType: 'image/png',
    bytes: new Uint8Array([1, 2, 3, 4]),
  })

  let failedErr = ''
  const unsub = runtime.events.subscribe((ev) => {
    if (ev.sessionId === s2.id && ev.type === 'run_finished') {
      failedErr = ev.error ?? ''
    }
  })
  await runtime.prompt(s2.id, {
    text: 'peek',
    attachments: [
      {
        blobId: blob.id,
        name: 'secret.png',
        mimeType: 'image/png',
        inlineOnly: true,
      },
    ],
  })
  await runtime.waitForIdle(s2.id)
  unsub()
  expect(failedErr).toContain(`belongs to session ${s1.id}, not ${s2.id}`)
})

test('session_start setActiveTools persists across turns and refreshes memory prompt section', async () => {
  const agentDir = makeTempDir('vela-r2-sessstart-agent-')
  const cwd = makeTempDir('vela-r2-sessstart-cwd-')
  const extPath = join(agentDir, 'ext-tools.mjs')
  writeFileSync(
    extPath,
    `export default function (pi) {
      pi.on('session_start', async (_event, ctx) => {
        ctx.session.setActiveTools(['read', 'memory'])
      })
    }`,
  )
  const runtime = createRuntime({
    agentDir,
    defaultModel: createFauxModel({
      responses: [fauxText('turn-1'), fauxText('turn-2')],
    }),
  })
  cleanups.push(() => runtime.dispose())

  const s = await runtime.sessions.create({
    id: 'ext-active-1',
    location: { environment: 'local', cwd },
  })
  await runtime.sessions.configure(s.id, {
    cwd,
    tools: ['read', 'bash'],
    extensions: [extPath],
  })

  const r1 = await runTextTurn(runtime, s.id, 'first')
  expect(r1.status).toBe('completed')
  const snap = await runtime.sessions.inspect(s.id, { previewPrompt: true })
  expect(snap.activeTools).toEqual(['read', 'memory'])
  expect(snap.promptSnapshot?.extensionSections.memory).toBeTruthy()

  const r2 = await runTextTurn(runtime, s.id, 'second')
  expect(r2.status).toBe('completed')
  const snap2 = await runtime.sessions.inspect(s.id)
  expect(snap2.activeTools).toEqual(['read', 'memory'])
})

test('async extension factory tool_call executes before core auditLog', async () => {
  const agentDir = makeTempDir('vela-r2-async-ext-agent-')
  const cwd = makeTempDir('vela-r2-async-ext-cwd-')
  const extPath = join(agentDir, 'async-block.mjs')
  writeFileSync(
    extPath,
    `export default async function (pi) {
      await Promise.resolve()
      pi.on('tool_call', async (event) => {
        if (event.toolName === 'bash') {
          return { block: true, reason: 'blocked-by-async-ext' }
        }
      })
    }`,
  )
  const runtime = createRuntime({
    agentDir,
    defaultModel: createFauxModel({
      responses: [
        fauxToolCall('bash', { command: 'echo HI_SHOULD_NOT_RUN' }),
        fauxText('done'),
      ],
    }),
  })
  cleanups.push(() => runtime.dispose())

  const s = await runtime.sessions.create({
    id: 'async-order-1',
    location: { environment: 'local', cwd },
  })
  await runtime.sessions.configure(s.id, { cwd, extensions: [extPath] })
  const res = await runTextTurn(runtime, s.id, 'run bash')
  expect(res.status).toBe('completed')

  const snap = await runtime.sessions.inspect(s.id)
  const toolResult = snap.entries.find(
    (e) =>
      e.type === 'message' &&
      e.message.role === 'tool' &&
      JSON.stringify(e.message.content).includes('blocked-by-async-ext'),
  )
  expect(toolResult).toBeDefined()
})

test('ephemeralSessions isolates tool spill dir and inherits existing trust & OAuth read-only', async () => {
  const agentDir = makeTempDir('vela-r2-ephem-agent-')
  const cwd = makeTempDir('vela-r2-ephem-cwd-')
  const owner = createRuntime({ agentDir })
  await owner.trust.approve({ environment: 'local', cwd }, true)
  await owner.oauthRegistrations.set('custom-oauth', {
    clientId: 'cid-123',
    hostId: 'h-1',
    subject: 'sub-1',
  })
  await owner.dispose()

  const runtime = createRuntime({
    ephemeralSessions: true,
    hostEnv: { VELA_DIR: agentDir },
    defaultModel: createFauxModel({ responses: [fauxText('ok')] }),
  })
  expect(runtime.agentDir).toBe(agentDir)
  expect(await runtime.trust.check({ environment: 'local', cwd })).toBe(true)
  expect((await runtime.oauthRegistrations.get('custom-oauth'))?.clientId).toBe(
    'cid-123',
  )

  const s = await runtime.sessions.create({
    id: 'ephem-bash-1',
    location: { environment: 'local', cwd },
  })
  const bigOut = 'x'.repeat(25_000)
  await runtime.sessions.execBash(s.id, `node -e "console.log('${bigOut}')"`)
  expect(existsSync(join(agentDir, 'sessions'))).toBe(false)
  await runtime.dispose()
})

test('sessions.inspect respects includeEntries: false and configure({}) clears specialModels', async () => {
  const agentDir = makeTempDir('vela-r2-inspect-agent-')
  const cwd = makeTempDir('vela-r2-inspect-cwd-')
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      model: 'openai/gpt-4o',
    }),
  )
  writeFileSync(
    join(agentDir, 'auth.json'),
    JSON.stringify({ openai: { type: 'api_key', key: 'sk-test' } }),
  )

  const runtime = createRuntime({
    agentDir,
  })
  cleanups.push(() => runtime.dispose())

  const s = await runtime.sessions.create({
    id: 'inspect-lite-1',
    location: { environment: 'local', cwd },
  })
  await runtime.sessions.configure(s.id, { cwd, model: 'mock' })
  const rMock = await runTextTurn(runtime, s.id, 'say mock')
  expect(rMock.status).toBe('completed')

  const full = await runtime.sessions.inspect(s.id)
  expect(full.entries.length).toBeGreaterThan(0)
  expect(full.branch.length).toBeGreaterThan(0)

  const lite = await runtime.sessions.inspect(s.id, { includeEntries: false })
  expect(lite.entries).toEqual([])
  expect(lite.branch).toEqual([])
  expect(lite.usage).toEqual(full.usage)
  expect(lite.allTools).toEqual(full.allTools)

  // Clearing override must drop the previous 'mock' special model handle and revert to owner config model
  await runtime.sessions.configure(s.id, { cwd })
  const snapAfterClear = await runtime.sessions.inspect(s.id)
  expect(snapAfterClear.modelInfo?.ref).toBe('openai/gpt-4o')
})

test('reloadConfig clears removed config keys and retries after malformed config recovery', async () => {
  const agentDir = makeTempDir('vela-r2-reload-agent-')
  const cwd = makeTempDir('vela-r2-reload-cwd-')
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({ tools: ['read'], limits: { maxRetries: 7 } }),
  )
  const runtime = createRuntime({
    agentDir,
    defaultModel: createFauxModel({ responses: [fauxText('ok')] }),
  })
  cleanups.push(() => runtime.dispose())

  const s = await runtime.sessions.create({
    id: 'reload-clear-1',
    location: { environment: 'local', cwd },
  })
  const before = await runtime.sessions.inspect(s.id)
  expect(before.activeTools).toEqual(['read'])
  expect(before.limits.maxRetries).toBe(7)

  // Write malformed JSON -> reloadConfig rejects without advancing signature cache
  writeFileSync(join(agentDir, 'config.json'), '{bad json')
  await expect(runtime.reloadConfig()).rejects.toThrow()

  // Fix JSON with removed `tools` & `limits` -> retry must succeed and clear both keys
  writeFileSync(join(agentDir, 'config.json'), JSON.stringify({}))
  await runtime.reloadConfig()
  const after = await runtime.sessions.inspect(s.id)
  expect(after.activeTools.length).toBeGreaterThan(1)
  expect(after.limits.maxRetries).not.toBe(7)
})

test('ensureCliProject isolates memory directories across project cwds', async () => {
  const agentDir = makeTempDir('vela-r2-projmem-agent-')
  const cwdA = makeTempDir('vela-r2-proj-a-')
  const cwdB = makeTempDir('vela-r2-proj-b-')
  const runtime = createRuntime({
    agentDir,
    defaultModel: createFauxModel({ responses: [fauxText('ok')] }),
  })
  cleanups.push(() => runtime.dispose())

  const projA = await ensureCliProject(runtime, cwdA)
  const projB = await ensureCliProject(runtime, cwdB)
  expect(projA).not.toBe(projB)
  expect(await ensureCliProject(runtime, cwdA)).toBe(projA)

  const memDirA = join(agentDir, 'projects', projA, 'memory')
  const memDirB = join(agentDir, 'projects', projB, 'memory')
  mkdirSync(memDirA, { recursive: true })
  mkdirSync(memDirB, { recursive: true })
  writeFileSync(join(memDirA, 'only-a.md'), '# Only A\nAlpha secret\n')

  const sB = await runtime.sessions.create({
    id: 'cli-proj-b',
    projectId: projB,
    location: { environment: 'local', cwd: cwdB },
  })
  const snapB = await runtime.sessions.inspect(sB.id, { previewPrompt: true })
  expect(snapB.promptSnapshot?.systemPrompt).not.toContain('Alpha secret')
  expect(readdirSync(memDirB)).toEqual([])
})

test('promoted background job stops cleanly after detaching foreground command', async () => {
  const agentDir = makeTempDir('vela-r2-bg-agent-')
  const cwd = makeTempDir('vela-r2-bg-cwd-')
  const runtime = createRuntime({
    agentDir,
    defaultModel: createFauxModel({ responses: [fauxText('ok')] }),
  })
  cleanups.push(() => runtime.dispose())

  const s = await runtime.sessions.create({
    id: 'bg-deadline-1',
    location: { environment: 'local', cwd },
  })
  const execPromise = runtime.sessions.execBash(s.id, 'sleep 10')
  let promoted: string[] = []
  for (let i = 0; i < 40 && promoted.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20))
    promoted = await runtime.jobs.promoteForeground(s.id)
  }
  expect(promoted.length).toBe(1)
  const res = await execPromise
  expect(res.backgroundTaskId).toBe(promoted[0])
  const tasks = await runtime.jobs.list(s.id)
  expect(
    tasks.some(
      (t) => t.snapshot.id === promoted[0] && t.snapshot.state === 'running',
    ),
  ).toBe(true)
  await runtime.jobs.stop(s.id, promoted[0]!)
})

test('tree fork and navigateTree release cached runner leases cleanly on session delete', async () => {
  const agentDir = makeTempDir('vela-r2-treelease-agent-')
  const cwd = makeTempDir('vela-r2-treelease-cwd-')
  const marker = join(agentDir, 'shutdown-fired')
  const extPath = join(agentDir, 'tree-lease-ext.mjs')
  writeFileSync(
    extPath,
    `import { writeFileSync } from 'node:fs'
export default function (pi) {
  pi.on('session_shutdown', () => {
    writeFileSync(${JSON.stringify(marker)}, 'yes')
  })
}`,
  )
  const runtime = createRuntime({
    agentDir,
    defaultModel: createFauxModel({ responses: [fauxText('hi-tree')] }),
  })
  cleanups.push(() => runtime.dispose())

  const s = await runtime.sessions.create({
    id: 'tree-lease-1',
    location: { environment: 'local', cwd },
  })
  await runtime.sessions.configure(s.id, { cwd, extensions: [extPath] })
  await runTextTurn(runtime, s.id, 'turn-1')
  const tree = await runtime.sessions.tree(s.id)
  const userEntry = tree.entries.find(
    (e) => e.type === 'message' && e.message.role === 'user',
  )
  expect(userEntry).toBeDefined()

  const forked = await runtime.sessions.fork(s.id, userEntry!.id)
  expect(forked.cancelled).toBe(false)
  const nav = await runtime.sessions.navigateTree(s.id, userEntry!.id)
  expect(nav.cancelled).toBe(false)

  await runtime.sessions.delete(s.id)
  expect(existsSync(marker)).toBe(true)
})
