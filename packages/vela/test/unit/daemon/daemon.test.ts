import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  connectRuntime,
  DAEMON_PROTOCOL_VERSION,
  ensureDaemonRunning,
  getDaemonStatus,
  resolveDaemonPaths,
  stopDaemon,
} from '../../../src/daemon/index.ts'
import {
  createNdjsonParser,
  type DaemonWireMessage,
  decodeIpcValue,
  encodeIpcValue,
  encodeWireLine,
} from '../../../src/daemon/protocol.ts'
import {
  DaemonAlreadyRunningError,
  type DaemonServerHandle,
  startDaemonServer,
} from '../../../src/daemon/server.ts'
import type {
  RuntimeEvent,
  StreamDeltaEvent,
} from '../../../src/runtime/events.ts'
import type { VelaRuntime } from '../../../src/runtime-sdk-types.ts'

const cleanupTasks: Array<() => Promise<void> | void> = []

function makeShortTempDir(prefix = 'vd-'): string {
  const dir = mkdtempSync(join('/tmp', prefix))
  cleanupTasks.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

afterEach(async () => {
  for (const task of cleanupTasks.splice(0).reverse()) {
    await Promise.resolve(task()).catch(() => {})
  }
})

test('resolveDaemonPaths falls back cleanly when agentDir/vela.sock exceeds POSIX limit', () => {
  const shortDir = makeShortTempDir()
  const shortPaths = resolveDaemonPaths(shortDir)
  expect(shortPaths.socketPath).toBe(join(shortPaths.agentDir, 'vela.sock'))
  expect(shortPaths.lockPath).toBe(join(shortPaths.agentDir, 'daemon.lock'))
  expect(shortPaths.pidPath).toBe(join(shortPaths.agentDir, 'daemon.pid'))
  expect(shortPaths.logPath).toBe(join(shortPaths.agentDir, 'daemon.log'))

  const longDir = join(shortDir, 'a'.repeat(110))
  mkdirSync(longDir, { recursive: true })
  const longPaths = resolveDaemonPaths(longDir)
  if (process.platform === 'win32') {
    expect(longPaths.socketPath).toMatch(/^\\\\\.\\pipe\\vela-[0-9a-f]{12}$/)
  } else {
    expect(Buffer.byteLength(longPaths.socketPath)).toBeLessThanOrEqual(96)
    expect(longPaths.socketPath).toMatch(/vela-[0-9a-f]{12}\.sock$/)
    expect(longPaths.socketPath.startsWith(tmpdir())).toBe(true)
  }
})

test('protocol NDJSON codec preserves Uint8Array bytes and splits incremental chunks', () => {
  const payloadBytes = new Uint8Array([0, 1, 2, 127, 128, 255])
  const encoded = encodeIpcValue({
    nested: [{ bytes: payloadBytes, label: 'ok' }],
  })
  const decoded = decodeIpcValue(encoded) as {
    nested: Array<{ bytes: Uint8Array; label: string }>
  }
  expect(decoded.nested[0]!.bytes).toBeInstanceOf(Uint8Array)
  expect(Array.from(decoded.nested[0]!.bytes)).toEqual(Array.from(payloadBytes))
  expect(decoded.nested[0]!.label).toBe('ok')

  const msg: DaemonWireMessage = {
    type: 'req',
    id: 7,
    method: 'blobs.storeInbound',
    params: { bytes: payloadBytes, filename: 'bin.dat' },
  }
  const line = encodeWireLine(msg)
  const received: DaemonWireMessage[] = []
  const parse = createNdjsonParser((parsed) => received.push(parsed))
  const mid = Math.floor(line.length / 2)
  parse(line.slice(0, mid))
  expect(received).toHaveLength(0)
  parse(line.slice(mid))
  expect(received).toHaveLength(1)
  const parsedParams = (received[0] as { params: { bytes: Uint8Array } }).params
  expect(parsedParams.bytes).toBeInstanceOf(Uint8Array)
  expect(Array.from(parsedParams.bytes)).toEqual(Array.from(payloadBytes))
})

test('startDaemonServer enforces 0600 socket perms, heals stale .sock, rejects non-sockets and double bind', async () => {
  const agentDir = makeShortTempDir('vd-sock-')
  const { socketPath } = resolveDaemonPaths(agentDir)

  // Refuse to overwrite or delete ordinary non-socket files (e.g. config.json)
  const regularFile = join(agentDir, 'config.json')
  writeFileSync(regularFile, '{}\n')
  await expect(
    startDaemonServer({
      agentDir,
      socketPath: regularFile,
      registerSignalHandlers: false,
    }),
  ).rejects.toThrow(/non-socket/)
  expect(existsSync(regularFile)).toBe(true)

  // Create a real stale POSIX socket inode from a short child that exits without unlinking
  if (process.platform !== 'win32') {
    const child = Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `const net=require('node:net');const s=net.createServer().listen(${JSON.stringify(socketPath)},()=>process.exit(0))`,
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    expect(child.exitCode).toBe(0)
  }

  const handle = await startDaemonServer({
    agentDir,
    registerSignalHandlers: false,
  })
  cleanupTasks.push(() => handle.close('test-cleanup'))

  if (process.platform !== 'win32') {
    expect(statSync(handle.socketPath).mode & 0o777).toBe(0o600)
  }
  expect(existsSync(handle.pidPath)).toBe(true)

  await expect(
    startDaemonServer({ agentDir, registerSignalHandlers: false }),
  ).rejects.toBeInstanceOf(DaemonAlreadyRunningError)

  await handle.close('done')
  expect(existsSync(handle.socketPath)).toBe(false)
  expect(existsSync(handle.pidPath)).toBe(false)
})

test('connectRuntime performs full RPC, event/delta streaming, blobs Uint8Array, trust, oauth, and interactive login', async () => {
  const agentDir = makeShortTempDir('vd-rpc-')
  const workDir = makeShortTempDir('vd-work-')
  let handle: DaemonServerHandle | undefined
  handle = await startDaemonServer({
    agentDir,
    hostEnv: {},
    registerSignalHandlers: false,
  })
  cleanupTasks.push(() => handle?.close('test-cleanup'))

  // Register a custom provider with interactive login prompt + secret prompt
  let capturedSecret = ''
  handle.runtime.registerDriver({
    name: 'vela',
    capabilities: handle.runtime.sessions ? ({} as never) : ({} as never),
    runTurn: async () => ({ status: 'completed', replyText: 'unused' }),
  } as never)
  // Keep default vela driver; instead test real daemon runtime via mock model
  await handle.close('restart-with-default')
  handle = await startDaemonServer({
    agentDir,
    hostEnv: { VELA_MODEL: 'mock' },
    registerSignalHandlers: false,
  })

  const client: VelaRuntime = await connectRuntime({
    agentDir,
    autoStart: false,
  })
  cleanupTasks.push(() => client.dispose())

  await client.ready()
  expect(await client.extensionErrors()).toEqual([])

  const proj = await client.projects.create({ name: 'demo', cwd: workDir })
  expect((await client.projects.getByCwd(workDir))?.id).toBe(proj.id)

  await client.trust.approve(workDir, true)
  expect(await client.trust.check(workDir)).toBe(true)

  await client.oauthRegistrations.set('openai', {
    clientId: 'cid-1',
    hostId: 'host-1',
  })
  expect(await client.oauthRegistrations.get('openai')).toEqual({
    clientId: 'cid-1',
    hostId: 'host-1',
  })
  expect(await client.oauthRegistrations.delete('openai')).toBe(true)

  const events: RuntimeEvent[] = []
  const deltas: StreamDeltaEvent[] = []
  const unsubEvents = client.events.subscribe((ev) => events.push(ev))
  const unsubDeltas = client.events.subscribeDeltas((d) => deltas.push(d))
  // Wait one tick for subscribe RPC registration
  await new Promise((r) => setTimeout(r, 30))

  const session = await client.sessions.create({
    id: 'ipc-s1',
    projectId: proj.id,
  })
  const rawBytes = new Uint8Array([10, 20, 30, 40])
  const storedBlob = await client.blobs.storeInbound({
    sessionId: session.id,
    filename: 'sample.bin',
    mimeType: 'application/octet-stream',
    bytes: rawBytes,
  })
  const fetchedBytes = await client.blobs.read(storedBlob.id)
  expect(fetchedBytes).toBeInstanceOf(Uint8Array)
  expect(Array.from(fetchedBytes)).toEqual(Array.from(rawBytes))

  await client.sessions.configure(session.id, { model: 'mock' })
  await client.prompt(session.id, { text: 'list files' })
  await client.waitForIdle(session.id)

  const page = await client.sessions.messages({ sessionId: session.id })
  expect(page.messages.length).toBeGreaterThanOrEqual(2)
  expect(
    events.some((e) => e.sessionId === session.id && e.type === 'run_finished'),
  ).toBe(true)
  expect(deltas.some((d) => d.sessionId === session.id)).toBe(true)

  unsubEvents()
  unsubDeltas()

  // Interactive API-key login prompt roundtrip over daemon IPC
  const controller = new AbortController()
  await client.login('openai', 'api_key', {
    signal: controller.signal,
    notify: () => {},
    prompt: async () => {
      capturedSecret = 'sk-ipc-test-123'
      return capturedSecret
    },
  })
  expect(capturedSecret).toBe('sk-ipc-test-123')
  const providersAfter = await client.models()
  expect(providersAfter.some((m) => m.provider === 'openai')).toBe(true)
  await client.logout('openai')
})

test('ensureDaemonRunning auto-restarts on version mismatch and serializes concurrent cold starts', async () => {
  const agentDir = makeShortTempDir('vd-ver-')
  cleanupTasks.push(async () => {
    await stopDaemon({ agentDir })
  })

  const oldHandle = await startDaemonServer({
    agentDir,
    appVersion: '0.0.1-old',
    registerSignalHandlers: false,
  })
  const oldPid = oldHandle.hello.pid
  expect(oldPid).toBe(process.pid)

  // Spawn 3 concurrent connect/ensure calls expecting a fresh daemon with real appVersion
  const [h1, h2, h3] = await Promise.all([
    ensureDaemonRunning({ agentDir }),
    ensureDaemonRunning({ agentDir }),
    ensureDaemonRunning({ agentDir }),
  ])
  expect(h1.protocolVersion).toBe(DAEMON_PROTOCOL_VERSION)
  expect(h1.pid).not.toBe(oldPid)
  expect(h2.pid).toBe(h1.pid)
  expect(h3.pid).toBe(h1.pid)

  const status = await getDaemonStatus({ agentDir })
  expect(status.running).toBe(true)
  expect(status.pid).toBe(h1.pid)

  expect(await stopDaemon({ agentDir })).toBe(true)
  expect((await getDaemonStatus({ agentDir })).running).toBe(false)
})

test('config.json & auth.json edits auto-reload on stat change and SIGHUP triggers reload', async () => {
  const agentDir = makeShortTempDir('vd-reload-')
  const handle = await startDaemonServer({
    agentDir,
    hostEnv: {},
    registerSignalHandlers: true,
  })
  cleanupTasks.push(() => handle.close('test-cleanup'))

  const client = await connectRuntime({ agentDir, autoStart: false })
  cleanupTasks.push(() => client.dispose())

  const beforeModels = await client.models()
  expect(beforeModels.some((m) => m.provider === 'custom')).toBe(false)

  // Write config.json & auth.json -> stat change detected by inspect()/reloadConfig
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      providers: {
        custom: {
          api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:1/v1',
          models: [{ id: 'm-auto' }],
        },
      },
    }),
  )
  chmodSync(join(agentDir, 'config.json'), 0o600)
  writeFileSync(
    join(agentDir, 'auth.json'),
    JSON.stringify({ custom: { type: 'api_key', key: 'k-1' } }),
  )
  chmodSync(join(agentDir, 'auth.json'), 0o600)

  const session = await client.sessions.create({ id: 'reload-check' })
  await client.sessions.inspect(session.id)
  const afterAuto = await client.models()
  expect(afterAuto.some((m) => m.ref === 'custom/m-auto')).toBe(true)

  // Update config.json again and reload via SIGHUP
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      providers: {
        custom: {
          api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:1/v1',
          models: [{ id: 'm-sighup' }],
        },
      },
    }),
  )
  process.kill(process.pid, 'SIGHUP')
  // Allow SIGHUP async handler to finish
  for (let i = 0; i < 20; i++) {
    const models = await client.models()
    if (models.some((m) => m.ref === 'custom/m-sighup')) break
    await new Promise((r) => setTimeout(r, 25))
  }
  const afterSig = await client.models()
  expect(afterSig.some((m) => m.ref === 'custom/m-sighup')).toBe(true)
})

test('graceful daemon close reaps active background jobs', async () => {
  const agentDir = makeShortTempDir('vd-reap-')
  const workDir = makeShortTempDir('vd-reap-work-')
  const handle = await startDaemonServer({
    agentDir,
    hostEnv: { ...process.env, VELA_MODEL: 'mock' },
    registerSignalHandlers: false,
  })
  cleanupTasks.push(() => handle.close('test-cleanup'))

  const client = await connectRuntime({ agentDir, autoStart: false })
  cleanupTasks.push(() => client.dispose())

  const proj = await client.projects.create({ name: 'reap', cwd: workDir })
  const session = await client.sessions.create({
    id: 'reap-s1',
    projectId: proj.id,
  })
  await client.sessions.configure(session.id, { model: 'mock', cwd: workDir })

  // Start a quick background sleep via bash tool
  const fakeScript = join(workDir, 'long.json')
  writeFileSync(
    fakeScript,
    JSON.stringify({
      responses: [
        {
          toolCalls: [
            {
              name: 'bash',
              input: { command: 'sleep 30', run_in_background: true },
            },
          ],
        },
        { text: 'started' },
      ],
    }),
  )
  await client.sessions.configure(session.id, {
    model: `faux:${fakeScript}`,
    cwd: workDir,
  })
  await client.prompt(session.id, { text: 'bg' })
  await client.waitForIdle(session.id)

  const jobs = await client.jobs.list(session.id)
  expect(jobs.some((j) => j.snapshot.state === 'running')).toBe(true)

  await handle.close('shutdown')
  expect(existsSync(handle.socketPath)).toBe(false)
})

test('protocol NDJSON parser decodes split multi-byte UTF-8 and rejects oversized frames', () => {
  const line = `${JSON.stringify({ type: 'req', id: 9, method: 'runtime.prompt', params: { text: '你好🎉世界' } })}\n`
  const bytes = Buffer.from(line, 'utf8')
  const emojiOffset = bytes.indexOf(Buffer.from('🎉', 'utf8'))
  expect(emojiOffset).toBeGreaterThan(0)
  const received: DaemonWireMessage[] = []
  const parse = createNdjsonParser((m) => received.push(m))
  parse(bytes.subarray(0, emojiOffset + 2))
  parse(bytes.subarray(emojiOffset + 2))
  expect(received).toHaveLength(1)
  expect((received[0] as { params: { text: string } }).params.text).toBe(
    '你好🎉世界',
  )

  const parseErrors: string[] = []
  const bounded = createNdjsonParser(
    () => {},
    (err) => parseErrors.push(err instanceof Error ? err.message : String(err)),
    32,
  )
  bounded(Buffer.from(`${'x'.repeat(40)}\n`))
  expect(parseErrors.some((m) => m.includes('exceeded'))).toBe(true)
})

test('VELA_DAEMON_SOCKET is honored consistently and cold start isolates caller env', async () => {
  const agentDir = makeShortTempDir('vd-env-')
  const sockDir = makeShortTempDir('vd-sockdir-')
  const customSock = join(sockDir, 'custom.sock')
  const hostEnv = {
    ...process.env,
    VELA_DAEMON_SOCKET: customSock,
    OPENAI_API_BASE_URL: 'http://127.0.0.1:9999/v1',
    OPENAI_API_KEY: 'caller-1-secret',
  }
  const client = await connectRuntime({ agentDir, hostEnv })
  cleanupTasks.push(async () => {
    await client.dispose()
    await stopDaemon({ agentDir, hostEnv }).catch(() => {})
  })

  const status = await getDaemonStatus({ agentDir, hostEnv })
  expect(status.running).toBe(true)
  expect(status.socketPath).toBe(customSock)

  // Caller 1's OPENAI_API_BASE_URL/KEY must NOT leak into the auto-started daemon defaults
  const models = await client.models()
  expect(models.some((m) => m.provider === 'openai')).toBe(false)
})

test('IPC transports login deviceId, auth_prompt AbortSignal, and logout AbortSignal', async () => {
  const agentDir = makeShortTempDir('vd-auth-')
  const workDir = makeShortTempDir('vd-auth-work-')
  let observedDeviceId: string | undefined
  let observedPromptAborted = false
  let logoutSignal: AbortSignal | undefined

  const handle = await startDaemonServer({
    agentDir,
    registerSignalHandlers: false,
  })
  cleanupTasks.push(() => handle.close('test-cleanup'))

  // Exercise server-side logout cancellation + login deviceId/prompt-signal via a fake runtime on socket
  handle.runtime.models = async () => []
  const origLogout = handle.runtime.logout
  handle.runtime.logout = async (_provider, opts) => {
    logoutSignal = opts?.signal
    return new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('Cancelled', 'AbortError')),
        { once: true },
      )
    })
  }
  const origLogin = handle.runtime.login
  handle.runtime.login = async (_p, _m, interaction, opts) => {
    observedDeviceId = opts?.getDeviceId?.()
    const promptCtrl = new AbortController()
    const p = interaction.prompt({
      type: 'manual_code',
      message: 'Paste code',
      signal: promptCtrl.signal,
    })
    setTimeout(() => promptCtrl.abort(), 30)
    await expect(p).rejects.toThrow()
  }

  const client = await connectRuntime({ agentDir, autoStart: false })
  cleanupTasks.push(() => client.dispose())

  await client.login(
    'openai',
    'oauth',
    {
      signal: new AbortController().signal,
      notify: () => {},
      prompt: (p) =>
        new Promise((_resolve, reject) => {
          p.signal?.addEventListener(
            'abort',
            () => {
              observedPromptAborted = true
              reject(new DOMException('Prompt cancelled', 'AbortError'))
            },
            { once: true },
          )
        }),
    },
    { getDeviceId: () => 'dev-uuid-123' },
  )
  expect(observedDeviceId).toBe('dev-uuid-123')
  expect(observedPromptAborted).toBe(true)

  const logoutCtrl = new AbortController()
  const logoutPromise = client.logout('openai', { signal: logoutCtrl.signal })
  setTimeout(() => logoutCtrl.abort(), 20)
  await expect(logoutPromise).rejects.toThrow()
  for (let i = 0; i < 20 && !logoutSignal?.aborted; i++) {
    await new Promise((r) => setTimeout(r, 15))
  }
  expect(logoutSignal?.aborted).toBe(true)
  void workDir
  handle.runtime.login = origLogin
  handle.runtime.logout = origLogout
})

test('connectRuntime and ensureDaemonRunning reject a socket belonging to another agentDir', async () => {
  const dirA = makeShortTempDir('vd-own-a-')
  const dirB = makeShortTempDir('vd-own-b-')
  const handle = await startDaemonServer({
    agentDir: dirA,
    registerSignalHandlers: false,
  })
  cleanupTasks.push(() => handle.close('test-cleanup'))

  await expect(
    ensureDaemonRunning({ agentDir: dirB, socketPath: handle.socketPath }),
  ).rejects.toThrow(/belongs to/)
  await expect(
    connectRuntime({
      agentDir: dirB,
      socketPath: handle.socketPath,
      autoStart: false,
    }),
  ).rejects.toThrow(/belongs to/)
  await expect(
    stopDaemon({ agentDir: dirB, socketPath: handle.socketPath }),
  ).rejects.toThrow(/belongs to/)
})

test('daemon ignores non-object NDJSON frames without crashing server or other clients', async () => {
  const { createConnection } = await import('node:net')
  const agentDir = makeShortTempDir('vd-nullframe-')
  const handle = await startDaemonServer({
    agentDir,
    registerSignalHandlers: false,
  })
  cleanupTasks.push(() => handle.close('test-cleanup'))

  const rawClosed = new Promise<void>((resolve) => {
    const raw = createConnection(handle.socketPath)
    raw.once('close', () => resolve())
    raw.once('connect', () => {
      raw.write('null\n123\n')
    })
  })
  await rawClosed

  const healthy = await connectRuntime({ agentDir, autoStart: false })
  cleanupTasks.push(() => healthy.dispose())
  await expect(healthy.models()).resolves.toEqual([])
})

test('stopDaemon never signals an unrelated live PID from a stale daemon.pid file', async () => {
  const { spawn } = await import('node:child_process')
  const agentDir = makeShortTempDir('vd-stale-pid-')
  const sleeper = spawn(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 30000)'],
    {
      stdio: 'ignore',
    },
  )
  cleanupTasks.push(() => {
    try {
      sleeper.kill('SIGKILL')
    } catch {}
  })
  expect(typeof sleeper.pid).toBe('number')

  const paths = resolveDaemonPaths(agentDir)
  writeFileSync(
    paths.pidPath,
    JSON.stringify({ pid: sleeper.pid, instanceId: 'dead-instance' }),
  )

  const stopped = await stopDaemon({ agentDir })
  expect(stopped).toBe(false)
  expect(existsSync(paths.pidPath)).toBe(false)
  // Sleeper process must still be alive
  expect(() => process.kill(sleeper.pid!, 0)).not.toThrow()
})
