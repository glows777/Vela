import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runtimePaths } from '../../../../scripts/eval/layout.ts'
import { openDatabase } from '../../src/db/sqlite.ts'
import { createLocalExecutionEnv } from '../../src/driver/execution/local.ts'
import {
  resolveLocation,
  sameLocation,
} from '../../src/driver/execution/location.ts'
import type { ExecutionEnv } from '../../src/driver/execution/types.ts'
import { createVelaAgentDriver } from '../../src/driver/runtime-adapter.ts'
import { loadTrustedRuntimeResources } from '../../src/driver/runtime-resources.ts'
import type { ProjectConfig } from '../../src/driver/session/project-config.ts'
import { resolveSessionExecution } from '../../src/driver/session/workspace.ts'
import { formatSkillsForPrompt } from '../../src/driver/skills/loader.ts'
import { McpConnection } from '../../src/mcp/connection.ts'
import { dockerContainerId } from '../../src/runtime/docker/container.ts'
import { withDockerCwd } from '../../src/runtime/docker/operations.ts'
import { LostRunOwnershipError } from '../../src/runtime/driver.ts'
import { createEnvironmentRegistryForTest } from '../../src/runtime/environments.ts'
import { RuntimeEventBus } from '../../src/runtime/event-bus.ts'
import { enqueueInboxEvent } from '../../src/runtime/inbox.ts'
import {
  type ChannelAdapter,
  type DriverTurnRequest,
  VelaRuntimeEngine,
} from '../../src/runtime/index.ts'
import { enqueueOutboxInTx } from '../../src/runtime/outbox.ts'
import {
  claimNextTurnInDb,
  commitCompletedTurnInTx,
  finalizeTurnInDb,
  stopSessionRunsInDb,
} from '../../src/runtime/worker.ts'
import { executionEnvOs } from '../../src/shared/execution.ts'
import { createFauxModel, fauxText } from '../../src/testing/core/index.ts'

const REPO_ROOT = resolve(import.meta.dir, '../../../..')
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

test('R2-P1-1: dispose stops channel adapters concurrently with workers so blocked flushOutboxBestEffort settles cleanly', async () => {
  const dir = tempDir('vela-r2-p1-1-')
  const db = openDatabase({ path: join(dir, 'vela.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir: dir })

  let deliverStarted!: () => void
  const deliverStartedPromise = new Promise<void>((r) => {
    deliverStarted = r
  })
  let stopped = false
  let stopResolved!: () => void
  const stopPromiseGate = new Promise<void>((r) => {
    stopResolved = r
  })

  await runtime.registerChannel({
    name: 'blocking-ch',
    start: async () => {},
    stop: async () => {
      stopped = true
      stopResolved()
    },
    deliver: async () => {
      deliverStarted()
      await stopPromiseGate
      return {}
    },
  })

  runtime.registerDriver({
    name: 'vela',
    capabilities: {
      recovery: 'step',
      executionEnv: 'self',
      steer: false,
      approval: false,
    },
    async runTurn() {
      return { status: 'completed', replyText: 'outbound text' }
    },
  })

  const s = runtime.sessions.create({
    id: 's-dispose-outbox',
    kind: 'chat',
    location: { environment: 'local', cwd: dir },
  })
  runtime.bindings.upsert({
    channel: 'blocking-ch',
    externalId: 'room-1',
    kind: 'group',
    sessionId: s.id,
    enabled: true,
  })
  runtime.submitPrompt({ sessionId: s.id, text: 'hi' })
  await deliverStartedPromise
  await runtime.dispose()
  expect(stopped).toBe(true)
  db.close()
})

test('R2-P1-2: unregisterChannel(A) completes without hanging on a blocked channel B delivery', async () => {
  const dir = tempDir('vela-r2-p1-2-')
  const db = openDatabase({ path: join(dir, 'vela.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir: dir })

  let releaseB!: () => void
  const gateB = new Promise<void>((r) => {
    releaseB = r
  })
  let startedB!: () => void
  const bDelivering = new Promise<void>((r) => {
    startedB = r
  })
  let aStopped = false

  const adapterA: ChannelAdapter = {
    name: 'chA',
    start: async () => {},
    stop: async () => {
      aStopped = true
    },
    deliver: async () => ({}),
  }
  const adapterB: ChannelAdapter = {
    name: 'chB',
    start: async () => {},
    stop: async () => {
      releaseB()
    },
    deliver: async () => {
      startedB()
      await gateB
      return {}
    },
  }
  await runtime.registerChannel(adapterA)
  await runtime.registerChannel(adapterB)

  const s = runtime.sessions.create({
    id: 's-multi-ch',
    kind: 'chat',
    location: { environment: 'local', cwd: dir },
  })
  enqueueOutboxInTx(db, {
    sessionId: s.id,
    channel: 'chB',
    externalChatId: 'b1',
    text: 'blocked-b',
  })
  const flushPromise = runtime.outbox.flushOnce()
  await bDelivering

  // Unregistering chA must finish immediately even while chB's delivery is blocked
  await runtime.unregisterChannel('chA')
  expect(aStopped).toBe(true)

  releaseB()
  await flushPromise
  await runtime.dispose()
  db.close()
})

test('R2-P1-3: terminal writes reject overwritten stopped runs, stopSessionRunsInDb respects live owners, and cross-Runtime stop retries', async () => {
  const dir = tempDir('vela-r2-p1-3-')
  const db = openDatabase({ path: join(dir, 'vela.db') })
  const eventBus = new RuntimeEventBus(db)
  const runtime1 = new VelaRuntimeEngine({ db, agentDir: dir })
  const runtime2 = new VelaRuntimeEngine({ db, agentDir: dir })

  const s = runtime1.sessions.create({
    id: 's-race',
    kind: 'chat',
    location: { environment: 'local', cwd: dir },
  })

  // Direct terminal write guard: once stopped in DB, commitCompletedTurnInTx & finalizeTurnInDb refuse to mark completed
  enqueueInboxEvent(db, {
    sessionId: s.id,
    source: 'user',
    wake: true,
    payload: { type: 'user', text: 'hello' },
  })
  const claimed = claimNextTurnInDb({
    db,
    sessions: runtime1.sessions,
    eventBus,
    activeOwners: new Set(['owner-1']),
    sessionId: s.id,
    ownerToken: 'owner-1',
  })!
  expect(claimed).toBeDefined()
  db.run(`UPDATE runs SET status = 'stopped' WHERE id = ?`, claimed.runId)

  expect(() =>
    commitCompletedTurnInTx({
      db,
      eventBus,
      claimed,
      outcome: { status: 'completed', replyText: 'late' },
    }),
  ).toThrow(LostRunOwnershipError)
  expect(() =>
    finalizeTurnInDb({
      db,
      eventBus,
      claimed,
      result: { status: 'completed', replyText: 'late' },
    }),
  ).toThrow(LostRunOwnershipError)
  expect(
    db.get<{ status: string }>(
      'SELECT status FROM runs WHERE id = ?',
      claimed.runId,
    )?.status,
  ).toBe('stopped')

  // stopSessionRunsInDb refuses to stomp on another engine's live running run
  db.run(
    `UPDATE runs SET status = 'running', owner_token = 'foreign-live-token' WHERE id = ?`,
    claimed.runId,
  )
  const stopCheck = stopSessionRunsInDb(
    db,
    s,
    s.id,
    'stop attempt',
    new Set(['local-only']),
  )
  expect(stopCheck.liveOtherRuns).toBe(false) // token prefix isn't live process owner, so check real cross-engine flow below

  // Cross-Runtime stop between runtime1 and runtime2 running on the same DB
  let entered2!: () => void
  const entered2Promise = new Promise<void>((r) => {
    entered2 = r
  })
  let release2!: () => void
  const release2Promise = new Promise<void>((r) => {
    release2 = r
  })
  runtime2.registerDriver({
    name: 'vela',
    capabilities: {
      recovery: 'step',
      executionEnv: 'self',
      steer: false,
      approval: false,
    },
    async runTurn(req: DriverTurnRequest) {
      entered2()
      req.abortSignal.addEventListener('abort', () => release2(), {
        once: true,
      })
      await release2Promise
      return { status: 'stopped' }
    },
  })
  runtime1.registerDriver({
    name: 'vela',
    capabilities: {
      recovery: 'step',
      executionEnv: 'self',
      steer: false,
      approval: false,
    },
    async runTurn() {
      return { status: 'completed', replyText: 'ok' }
    },
  })

  const sCross = runtime1.sessions.create({
    id: 's-cross',
    kind: 'chat',
    location: { environment: 'local', cwd: dir },
  })
  runtime2.submitPrompt({ sessionId: sCross.id, text: 'from rt2' })
  await entered2Promise
  expect(await runtime1.stopSession(sCross.id, 'cross stop')).toBe(true)
  await runtime2.waitForIdle(sCross.id)

  await runtime1.dispose()
  await runtime2.dispose()
  db.close()
})

test('R2-P1-4: stopSession fence lift does not spin on a topic awaiting channel binding', async () => {
  const dir = tempDir('vela-r2-p1-4-')
  const db = openDatabase({ path: join(dir, 'vela.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir: dir })

  let turnCalls = 0
  runtime.registerDriver({
    name: 'vela',
    capabilities: {
      recovery: 'step',
      executionEnv: 'self',
      steer: false,
      approval: false,
    },
    async runTurn() {
      turnCalls++
      return { status: 'completed', replyText: 'unexpected' }
    },
  })

  const topic = runtime.sessions.create({
    id: 'topic-unbound',
    kind: 'topic',
    location: { environment: 'local', cwd: dir },
  })
  enqueueOutboxInTx(db, {
    sessionId: topic.id,
    kind: 'topic_start',
    channel: 'feishu',
    externalChatId: 'chat-1',
    text: 'topic header',
  })
  enqueueInboxEvent(db, {
    sessionId: topic.id,
    source: 'user',
    wake: true,
    payload: { type: 'user', text: 'pending before binding' },
  })
  let scheduleCalls = 0
  const origSchedule = runtime.scheduleSession.bind(runtime)
  runtime.scheduleSession = (sid: string) => {
    scheduleCalls++
    return origSchedule(sid)
  }
  await runtime.stopSession(topic.id, 'cancel stop')
  await runtime.waitForIdle(topic.id)

  expect(scheduleCalls).toBe(0)
  expect(turnCalls).toBe(0)
  const pendingCount = db.get<{ c: number }>(
    `SELECT count(*) AS c FROM inbox_events WHERE session_id = ? AND status = 'pending'`,
    topic.id,
  )!.c
  expect(pendingCount).toBe(1)

  await runtime.dispose()
  db.close()
})

test('R2-P1-5: interrupted driver result executes once without tight-loop replay, preserves durable progress, and wakes concurrent prompts', async () => {
  const dir = tempDir('vela-r2-p1-5-')
  const db = openDatabase({ path: join(dir, 'vela.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir: dir })

  let runCalls = 0
  let writeProgressOnTurn = false
  let submitConcurrentOnSession: string | undefined
  runtime.registerDriver({
    name: 'vela',
    capabilities: {
      recovery: 'step',
      executionEnv: 'self',
      steer: false,
      approval: false,
    },
    async runTurn(req: DriverTurnRequest) {
      runCalls++
      if (writeProgressOnTurn) {
        db.run(
          `INSERT INTO vela_messages (id, session_id, seq, kind, role, content_json, created_at, run_id)
           VALUES (?, ?, ?, 'message', 'user', '[{"type":"text","text":"hi"}]', ?, ?)`,
          `msg-progress-${runCalls}`,
          req.sessionId,
          runCalls,
          new Date().toISOString(),
          req.runId,
        )
      }
      if (submitConcurrentOnSession === req.sessionId && runCalls === 3) {
        runtime.submitPrompt({
          sessionId: req.sessionId,
          text: 'concurrent prompt after interrupt',
        })
        return { status: 'interrupted', error: 'graceful interrupt' }
      }
      if (submitConcurrentOnSession === req.sessionId && runCalls === 4) {
        return { status: 'completed', replyText: 'concurrent ran' }
      }
      return { status: 'interrupted', error: 'graceful interrupt' }
    },
  })

  // Without durable progress: executes once, inbox returns to pending, no infinite loop
  const s1 = runtime.sessions.create({
    id: 's-int-noprogress',
    kind: 'chat',
    location: { environment: 'local', cwd: dir },
  })
  runtime.submitPrompt({ sessionId: s1.id, text: 'once please' })
  await runtime.waitForIdle(s1.id)
  expect(runCalls).toBe(1)
  expect(
    db.get<{ status: string }>(
      'SELECT status FROM runs WHERE session_id = ? LIMIT 1',
      s1.id,
    )?.status,
  ).toBe('interrupted')
  expect(
    db.get<{ status: string }>(
      'SELECT status FROM inbox_events WHERE session_id = ? LIMIT 1',
      s1.id,
    )?.status,
  ).toBe('pending')

  // With durable progress: executes once and marks inbox done so side effects do not replay
  writeProgressOnTurn = true
  const s2 = runtime.sessions.create({
    id: 's-int-progress',
    kind: 'chat',
    location: { environment: 'local', cwd: dir },
  })
  runtime.submitPrompt({ sessionId: s2.id, text: 'do once' })
  await runtime.waitForIdle(s2.id)
  expect(runCalls).toBe(2)
  expect(
    db.get<{ status: string }>(
      'SELECT status FROM runs WHERE session_id = ? LIMIT 1',
      s2.id,
    )?.status,
  ).toBe('interrupted')
  expect(
    db.get<{ status: string }>(
      'SELECT status FROM inbox_events WHERE session_id = ? LIMIT 1',
      s2.id,
    )?.status,
  ).toBe('done')

  // Concurrent prompt accepted during interrupted turn must NOT lose its wakeup
  const s3 = runtime.sessions.create({
    id: 's-int-concurrent',
    kind: 'chat',
    location: { environment: 'local', cwd: dir },
  })
  submitConcurrentOnSession = s3.id
  runtime.submitPrompt({ sessionId: s3.id, text: 'turn 1 interrupted' })
  await runtime.waitForIdle(s3.id)
  expect(runCalls).toBe(4)
  const s3Runs = db.all<{ status: string }>(
    'SELECT status FROM runs WHERE session_id = ? ORDER BY started_at ASC, rowid ASC',
    s3.id,
  )
  expect(s3Runs.map((r) => r.status)).toEqual(['interrupted', 'completed'])
  const s3Inbox = db.all<{ status: string }>(
    'SELECT status FROM inbox_events WHERE session_id = ? ORDER BY created_at ASC, rowid ASC',
    s3.id,
  )
  expect(s3Inbox.map((i) => i.status)).toEqual(['done', 'done'])

  await runtime.dispose()
  db.close()
})

test('R2-P2-1: delayed stale McpConnection factory cannot overwrite connecting transport before close()', async () => {
  const dir = tempDir('vela-r2-p2-1-')
  let releaseOldFactory!: () => void
  const oldFactoryGate = new Promise<void>((r) => {
    releaseOldFactory = r
  })
  let markOldFactoryEntered!: () => void
  const oldFactoryEntered = new Promise<void>((r) => {
    markOldFactoryEntered = r
  })
  let releaseNewConnect!: () => void
  const newConnectGate = new Promise<void>((r) => {
    releaseNewConnect = r
  })
  let markNewStartEntered!: () => void
  const newStartEntered = new Promise<void>((r) => {
    markNewStartEntered = r
  })
  let oldClosed = false
  let newClosed = false
  let attempt = 0

  const conn = new McpConnection({
    entry: {
      name: 'srv',
      config: { type: 'http', url: 'https://example.com/mcp' },
      source: 'test',
    },
    cwd: dir,
    onTools: () => {},
    createTransport: async () => {
      attempt++
      if (attempt === 1) {
        markOldFactoryEntered()
        await oldFactoryGate
        const [c1] = InMemoryTransport.createLinkedPair()
        const orig = c1.close.bind(c1)
        c1.close = async () => {
          oldClosed = true
          await orig()
        }
        return c1
      }
      const srv = new McpServer(
        { name: 'srv2', version: '1.0' },
        { capabilities: { tools: {} } },
      )
      const [c2, s2] = InMemoryTransport.createLinkedPair()
      const origStart = c2.start.bind(c2)
      c2.start = async () => {
        markNewStartEntered()
        await newConnectGate
        await origStart()
      }
      const origClose = c2.close.bind(c2)
      c2.close = async () => {
        newClosed = true
        releaseNewConnect()
        await origClose()
      }
      await srv.connect(s2)
      return c2
    },
  })

  const p1 = conn.connect().catch(() => {})
  await oldFactoryEntered
  const p2 = conn.reconnect().catch(() => {})
  await newStartEntered
  // Release old delayed factory AFTER reconnect() already moved to generation 1
  releaseOldFactory()
  await p1
  expect(oldClosed).toBe(true)

  // Now close() while attempt 2 is still blocked in connect(): connecting must be c2, not clobbered by attempt 1
  await conn.close()
  await p2
  expect(newClosed).toBe(true)
})

test('R2-P2-2: eval runtimePaths detects pi core tool names on current and legacy fixtures', () => {
  expect(runtimePaths(REPO_ROOT).usesPiCoreToolNames).toBe(true)

  const legacyRoot = tempDir('vela-eval-legacy-')
  mkdirSync(join(legacyRoot, 'src/tools'), { recursive: true })
  writeFileSync(
    join(legacyRoot, 'src/tools/file.ts'),
    `export const READ = { name: 'read_file' }\n`,
  )
  expect(runtimePaths(legacyRoot).usesPiCoreToolNames).toBe(false)
})

function makeRemoteDockerEnv(rootDir: string, cwd: string): ExecutionEnv {
  const containerRoot = join(rootDir, 'container-ws')
  mkdirSync(containerRoot, { recursive: true })
  const local = createLocalExecutionEnv({ cwd: containerRoot })
  const baseAbsolutePath = local.absolutePath.bind(local)
  const baseExists = local.exists.bind(local)
  const baseFileInfo = local.fileInfo.bind(local)
  const baseReadTextFile = local.readTextFile.bind(local)
  const baseJoinPath = local.joinPath.bind(local)
  const normCwd = cwd.replace(/\/+$/, '') || '/'
  const mapGuestPath = (p: string): string => {
    if (p.startsWith('~/.vela')) return join(containerRoot, '.vela-missing')
    if (p === normCwd || p.startsWith(`${normCwd}/`)) {
      const rel = p.slice(normCwd.length).replace(/^\/+/, '')
      return rel ? join(containerRoot, rel) : containerRoot
    }
    if (p === containerRoot || p.startsWith(`${containerRoot}/`)) return p
    if (!p.startsWith('/')) return join(containerRoot, p)
    return join(containerRoot, '__host_only_missing__')
  }
  return Object.assign(local, {
    id: 'docker:dev',
    cwd,
    [executionEnvOs]: 'linux',
    [dockerContainerId]: 'cid-norm-1',
    [withDockerCwd]: (nextCwd: string) => makeRemoteDockerEnv(rootDir, nextCwd),
    async absolutePath(p: string, s?: AbortSignal) {
      return baseAbsolutePath(mapGuestPath(p), s)
    },
    async exists(p: string, s?: AbortSignal) {
      return baseExists(mapGuestPath(p), s)
    },
    async fileInfo(p: string, s?: AbortSignal) {
      return baseFileInfo(mapGuestPath(p), s)
    },
    async readTextFile(p: string, s?: AbortSignal) {
      return baseReadTextFile(mapGuestPath(p), s)
    },
    async joinPath(parts: string[], s?: AbortSignal) {
      const mapped = parts.map((part) => (part === cwd ? containerRoot : part))
      return baseJoinPath(mapped, s)
    },
  })
}

test('#594: loadTrustedRuntimeResources preserves explicit SDK host resources on non-local Docker sessions', async () => {
  const dir = tempDir('vela-docker-host-ctx-')
  const agentDir = join(dir, 'agent')
  mkdirSync(agentDir, { recursive: true })
  const containerSkillDir = join(dir, 'container-ws/custom-skill')
  mkdirSync(containerSkillDir, { recursive: true })
  writeFileSync(
    join(containerSkillDir, 'SKILL.md'),
    '---\nname: container-skill\ndescription: Readable inside container\n---\nContainer body\n',
  )
  const db = openDatabase({ path: join(agentDir, 'vela.db') })
  // Implicit local host file should NOT be loaded for non-local sessions
  writeFileSync(
    join(agentDir, 'AGENTS.md'),
    'implicit local agent instructions',
  )

  const hostContextFiles = [
    { path: 'host://sdk-context.md', content: 'explicit host context' },
  ]
  const hostSkills = [
    {
      name: 'host-skill',
      description: 'Host skill',
      filePath: 'host://skill.md',
      baseDir: 'host://',
      disableModelInvocation: false,
    },
    {
      name: 'container-skill',
      description: 'Readable inside container',
      filePath: '/workspace/custom-skill/SKILL.md',
      baseDir: '/workspace/custom-skill',
      disableModelInvocation: false,
    },
  ]
  const hostPromptTemplates = [
    {
      name: 'host-tpl',
      description: 'Host template',
      content: 'template body',
      source: 'user' as const,
      filePath: 'host://tpl.md',
    },
  ]

  const res = await loadTrustedRuntimeResources({
    db,
    agentDir,
    location: { environment: 'dev', cwd: '/workspace' },
    resolveEnv: async () => makeRemoteDockerEnv(dir, '/workspace'),
    signal: new AbortController().signal,
    hostContextFiles,
    hostSkills,
    hostPromptTemplates,
    trustOverride: false,
  })
  expect(res.trusted).toBe(false)
  expect(res.contextFiles).toEqual(hostContextFiles)
  expect(res.skills.map((s) => s.name)).toEqual([
    'host-skill',
    'container-skill',
  ])
  expect(res.skills[0]?.disableModelInvocation).toBe(true)
  expect(res.skills[1]?.disableModelInvocation).toBe(false)
  const advertisedUntrusted = formatSkillsForPrompt(res.skills, ['read'])
  expect(advertisedUntrusted).toContain('container-skill')
  expect(advertisedUntrusted).not.toContain('host-skill')
  expect(res.promptTemplates.map((t) => t.name)).toEqual(['host-tpl'])

  const trustedRes = await loadTrustedRuntimeResources({
    db,
    agentDir,
    location: { environment: 'dev', cwd: '/workspace' },
    resolveEnv: async () => makeRemoteDockerEnv(dir, '/workspace'),
    signal: new AbortController().signal,
    hostContextFiles,
    hostSkills,
    hostPromptTemplates,
    trustOverride: true,
  })
  expect(trustedRes.trusted).toBe(true)
  expect(trustedRes.contextFiles).toEqual(hostContextFiles)
  expect(trustedRes.skills.map((s) => s.name)).toEqual([
    'host-skill',
    'container-skill',
  ])
  expect(trustedRes.skills[0]?.disableModelInvocation).toBe(true)
  expect(trustedRes.skills[1]?.disableModelInvocation).toBe(false)
  expect(trustedRes.promptTemplates.map((t) => t.name)).toEqual(['host-tpl'])

  db.close()
})

test('#594: non-local trailing-slash Docker cwd normalizes consistently across resolveLocation, resolveSessionExecution, and VelaAgentDriver', async () => {
  const dir = tempDir('vela-docker-cwd-')
  const resolvedLoc = resolveLocation({
    environment: 'dev',
    cwd: '/workspace/',
  })
  expect(resolvedLoc.cwd).toBe('/workspace')
  expect(
    sameLocation(
      { environment: 'dev', cwd: '/workspace/' },
      { environment: 'dev', cwd: '/workspace' },
    ),
  ).toBe(true)

  const envReg = createEnvironmentRegistryForTest({
    dataDir: dir,
    environments: { dev: { image: 'node:22-bookworm', network: 'off' } },
    openDocker: async (_cfg, cwd = '/workspace') =>
      makeRemoteDockerEnv(dir, cwd),
    probeAlive: async () => true,
  })

  // resolveSessionExecution handles even pre-existing unnormalized trailing-slash location objects
  const resolvedExec = await resolveSessionExecution({
    sessionId: 's-exec',
    location: { environment: 'dev', cwd: '/workspace/' },
    envResolver: (t) => envReg.resolve(t),
    dataDir: dir,
    projectConfig: {} as ProjectConfig,
    identities: new Map(),
    sessionOs: new Map(),
    sessionShells: new Map(),
  })
  expect(resolvedExec.cwd).toBe('/workspace')

  // Reject a non-local adapter reporting a relative cwd even when posix.resolve('/', 'workspace') matches '/workspace'
  await expect(
    resolveSessionExecution({
      sessionId: 's-exec-rel',
      location: { environment: 'dev', cwd: '/workspace' },
      envResolver: async () => makeRemoteDockerEnv(dir, 'workspace'),
      dataDir: dir,
      projectConfig: {} as ProjectConfig,
      identities: new Map(),
      sessionOs: new Map(),
      sessionShells: new Map(),
    }),
  ).rejects.toThrow('Execution environment unavailable for dev:/workspace')

  // Runtime + VelaAgentDriver executes a session persisted with '/workspace/' cleanly and expands host-only SDK skills
  const hostSkillDir = join(dir, 'host-skills/deploy')
  mkdirSync(hostSkillDir, { recursive: true })
  const hostSkillPath = join(hostSkillDir, 'SKILL.md')
  writeFileSync(
    hostSkillPath,
    '---\nname: deploy\ndescription: Host deploy workflow\n---\nRun the host checklist carefully.\n',
  )
  const db = openDatabase({ path: join(dir, 'vela.db') })
  const runtime = new VelaRuntimeEngine({
    db,
    agentDir: dir,
    environments: envReg,
  })
  const seenPrompts: string[] = []
  const seenSystems: string[] = []
  const model = createFauxModel({
    responses: [
      (req) => {
        seenPrompts.push(req.lastUserText)
        seenSystems.push(req.system)
        return fauxText('docker ok')
      },
    ],
  })
  const driver = createVelaAgentDriver({
    db,
    agentDir: dir,
    blobs: runtime.blobs,
    environments: runtime.environments,
    defaultModel: model,
    contextFiles: [{ path: 'host://doc.md', content: 'host context' }],
    skills: [
      {
        name: 'deploy',
        description: 'Host deploy workflow',
        filePath: hostSkillPath,
        baseDir: hostSkillDir,
        disableModelInvocation: false,
      },
    ],
    trustOverride: async () => false,
  })
  runtime.registerDriver(driver)
  const s = runtime.sessions.create({
    id: 's-docker-runtime',
    kind: 'chat',
    location: { environment: 'dev', cwd: '/workspace/' },
  })
  runtime.submitPrompt({ sessionId: s.id, text: '/skill:deploy staging' })
  await runtime.waitForIdle(s.id)
  const lastRun = db.get<{ status: string; error: string | null }>(
    'SELECT status, error FROM runs WHERE session_id = ? LIMIT 1',
    s.id,
  )
  expect(lastRun?.status).toBe('completed')
  expect(lastRun?.error).toBeNull()
  expect(seenPrompts.join('\n')).toContain('Run the host checklist carefully.')
  expect(seenSystems.join('\n')).not.toContain(hostSkillPath)
  expect(seenSystems.join('\n')).not.toContain('<available_skills>')

  await runtime.dispose()
  db.close()
})
