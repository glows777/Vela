import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { stopDaemon } from '../../packages/vela/src/daemon/index.ts'
import { openDatabase } from '../../packages/vela/src/db/sqlite.ts'
import { canonicalLocalPath } from '../../packages/vela/src/db/trust.ts'

setDefaultTimeout(30_000)

const ROOT = resolve(import.meta.dir, '../..')
const ENTRY = join(ROOT, 'packages/vela/src/cli/main.ts')

const cleanupDirs: string[] = []
const trackedAgentDirs = new Set<string>()

function makeShortDir(prefix = 'vd-e2e-'): string {
  const dir = join(
    '/tmp',
    `${prefix}${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  )
  mkdirSync(dir, { recursive: true })
  cleanupDirs.push(dir)
  return dir
}

async function runCli(
  args: string[],
  options: {
    cwd?: string
    agentDir: string
    env?: Record<string, string>
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  trackedAgentDirs.add(options.agentDir)
  const proc = Bun.spawn(['bun', ENTRY, ...args], {
    cwd: options.cwd ?? ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: options.agentDir,
      VELA_DIR: options.agentDir,
      ...options.env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

afterAll(async () => {
  await Promise.all(
    [...trackedAgentDirs].map((agentDir) =>
      stopDaemon({ agentDir }).catch(() => {}),
    ),
  )
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('vela daemon start / status / stop manages a single resident daemon PID', async () => {
  const agentDir = makeShortDir('vd-ctrl-')

  const initial = await runCli(['daemon', 'status'], { agentDir })
  expect(initial.code).toBe(0)
  expect(initial.stdout).toContain('Vela daemon stopped')

  const started = await runCli(['daemon', 'start'], { agentDir })
  expect(started.code).toBe(0)
  const pidMatch = started.stdout.match(/pid (\d+)/)
  expect(pidMatch).not.toBeNull()
  const pid = Number(pidMatch![1])

  const status = await runCli(['daemon', 'status'], { agentDir })
  expect(status.code).toBe(0)
  expect(status.stdout).toContain(`pid ${pid}`)

  // Second start is idempotent and keeps the same resident daemon PID
  const startedAgain = await runCli(['daemon', 'start'], { agentDir })
  expect(startedAgain.code).toBe(0)
  expect(startedAgain.stdout).toContain(`pid ${pid}`)

  const stopped = await runCli(['daemon', 'stop'], { agentDir })
  expect(stopped.code).toBe(0)
  expect(stopped.stdout).toContain('Vela daemon stopped')

  const after = await runCli(['daemon', 'status'], { agentDir })
  expect(after.code).toBe(0)
  expect(after.stdout).toContain('Vela daemon stopped')
})

test('retired commands `vela serve` and `--mode rpc` exit with code 2 and migration guidance', async () => {
  const agentDir = makeShortDir('vd-ret-')

  const serveRes = await runCli(['serve'], { agentDir })
  expect(serveRes.code).toBe(2)
  expect(serveRes.stderr).toContain('vela daemon start')
  expect(serveRes.stderr).toContain('connectRuntime()')

  const rpcRes = await runCli(['--mode', 'rpc', 'hello'], { agentDir })
  expect(rpcRes.code).toBe(2)
  expect(rpcRes.stderr).toContain('connectRuntime()')
  expect(rpcRes.stderr).toContain('--mode json')

  expect(existsSync(join(agentDir, 'daemon.pid'))).toBe(false)
})

test('CLI -p and --mode json reuse resident daemon PID and isolate per-session env & --no-session', async () => {
  const agentDir = makeShortDir('vd-share-')
  const workDir = makeShortDir('vd-work-')
  const scenarioPath = join(workDir, 'reply.json')
  const recordPath = join(workDir, 'rec.json')
  writeFileSync(
    scenarioPath,
    JSON.stringify({
      responses: [{ text: 'from faux one' }, { text: 'from faux two' }],
    }),
  )

  const daemonStart = await runCli(['daemon', 'start'], { agentDir })
  expect(daemonStart.code).toBe(0)
  const daemonPid = Number(daemonStart.stdout.match(/pid (\d+)/)![1])

  // 1. -p with transient VELA_MODEL + VELA_RECORD
  const pRes = await runCli(['-p', 'first prompt'], {
    cwd: workDir,
    agentDir,
    env: {
      VELA_MODEL: `faux:${scenarioPath}`,
      VELA_RECORD: recordPath,
    },
  })
  expect(pRes.code).toBe(0)
  expect(pRes.stdout.trim()).toBe('from faux one')
  expect(existsSync(recordPath)).toBe(true)

  // 2. --mode json emits v0.9 RuntimeEvent NDJSON and reuses the same daemon PID
  const jRes = await runCli(['--mode', 'json', 'second prompt'], {
    cwd: workDir,
    agentDir,
    env: { VELA_MODEL: `faux:${scenarioPath}` },
  })
  expect(jRes.code).toBe(0)
  const events = jRes.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; status?: string })
  expect(events[0]?.type).toBe('session')
  expect(events.some((e) => e.type === 'run_started')).toBe(true)
  expect(events.some((e) => e.type === 'message_committed')).toBe(true)
  expect(
    events.some((e) => e.type === 'run_finished' && e.status === 'completed'),
  ).toBe(true)

  const statusAfter = await runCli(['daemon', 'status'], { agentDir })
  expect(statusAfter.stdout).toContain(`pid ${daemonPid}`)

  // 3. Transient env did not leak onto daemon defaults or config.json/auth.json
  expect(existsSync(join(agentDir, 'config.json'))).toBe(false)
  expect(existsSync(join(agentDir, 'auth.json'))).toBe(false)
  const noModelRes = await runCli(['-p', 'should fail without model'], {
    cwd: workDir,
    agentDir,
    env: { VELA_MODEL: '' },
  })
  expect(noModelRes.code).toBe(1)

  // 4. --no-session does not start a daemon or write vela.db
  const isolatedAgentDir = makeShortDir('vd-eph-')
  const ephRes = await runCli(['--no-session', '-p', 'ephemeral check'], {
    cwd: workDir,
    agentDir: isolatedAgentDir,
    env: { VELA_MODEL: `faux:${scenarioPath}` },
  })
  expect(ephRes.code).toBe(0)
  expect(ephRes.stdout.trim()).toBe('from faux one')
  expect(existsSync(join(isolatedAgentDir, 'vela.db'))).toBe(false)
  expect(existsSync(join(isolatedAgentDir, 'daemon.pid'))).toBe(false)
})

test('-c continues the latest non-channel session matching canonical cwd', async () => {
  const agentDir = makeShortDir('vd-cont-')
  const dirA = makeShortDir('vd-cwd-a-')
  const dirB = makeShortDir('vd-cwd-b-')
  const scenarioPath = join(dirA, 's.json')
  writeFileSync(
    scenarioPath,
    JSON.stringify({
      responses: [
        { text: 'answer A' },
        { text: 'answer B' },
        { text: 'continued A' },
      ],
    }),
  )

  const rA = await runCli(['--session', 'sess-a', '-p', 'in A'], {
    cwd: dirA,
    agentDir,
    env: { VELA_MODEL: `faux:${scenarioPath}` },
  })
  expect(rA.code).toBe(0)

  const rB = await runCli(['--session', 'sess-b', '-p', 'in B'], {
    cwd: dirB,
    agentDir,
    env: { VELA_MODEL: `faux:${scenarioPath}` },
  })
  expect(rB.code).toBe(0)

  // Insert a newer channel session in dirA that `-c` must exclude
  const db = openDatabase({ path: join(agentDir, 'vela.db') })
  try {
    const now = new Date(Date.now() + 60_000).toISOString()
    db.run(
      `INSERT INTO sessions (id, project_id, kind, driver, name, archived, location_json, discovered_tools_json, state, followup_streak, created_at, updated_at)
       VALUES (?, NULL, 'chat', 'vela', NULL, 0, ?, '[]', 'idle', 0, ?, ?)`,
      'channel-newer',
      JSON.stringify({ environment: 'local', cwd: canonicalLocalPath(dirA) }),
      now,
      now,
    )
    db.run(
      `INSERT INTO channel_bindings (id, channel, external_id, thread_id, kind, project_id, session_id, enabled, created_at, updated_at)
       VALUES ('b1', 'lark', 'chat-1', NULL, 'direct', NULL, 'channel-newer', 1, ?, ?)`,
      now,
      now,
    )
  } finally {
    db.close()
  }

  const contA = await runCli(['-c', '--mode', 'json', 'follow up A'], {
    cwd: dirA,
    agentDir,
    env: { VELA_MODEL: `faux:${scenarioPath}` },
  })
  expect(contA.code).toBe(0)
  const sessionHeader = JSON.parse(contA.stdout.trim().split('\n')[0]!) as {
    type: string
    id: string
  }
  expect(sessionHeader.type).toBe('session')
  expect(sessionHeader.id).toBe('sess-a')
  expect(readFileSync(scenarioPath, 'utf8')).toContain('answer A')
})
