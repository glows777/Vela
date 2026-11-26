import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { openDatabase } from '../../src/db/sqlite.ts'
import { createVela } from '../../src/driver/index.ts'
import {
  createRuntime,
  fileCredentialStore,
  type RuntimeEvent,
  type StreamDeltaEvent,
} from '../../src/index.ts'
import { resetIdTokenCache } from '../../src/providers/auth/oauth/id-token.ts'
import {
  openaiChatGPTLogin,
  revocationTiming,
} from '../../src/providers/auth/oauth/openai-chatgpt.ts'
import { memoryCredentialStore } from '../../src/providers/auth/store.ts'
import type {
  AuthInteraction,
  AuthPrompt,
} from '../../src/providers/auth/types.ts'
import {
  ModelRegistry,
  type ProviderDefinition,
} from '../../src/providers/models/index.ts'
import {
  type ChannelAdapter,
  SqliteOAuthRegistrationStore,
} from '../../src/runtime/index.ts'
import {
  createFauxModel,
  fauxHang,
  fauxText,
  fauxToolCall,
} from '../../src/testing/core/index.ts'

const dirs: string[] = []
const realFetch = globalThis.fetch
const REAL_TIMING = { ...revocationTiming }

beforeEach(() => {
  resetIdTokenCache()
  revocationTiming.backoffMs = [10, 10]
  revocationTiming.budgetMs = 300
})

afterEach(() => {
  globalThis.fetch = realFetch
  revocationTiming.backoffMs = REAL_TIMING.backoffMs
  revocationTiming.budgetMs = REAL_TIMING.budgetMs
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const DEVICE = '0b9d6f3e-8c1a-4f2e-9d7b-5a6c4e3f2a10'
const OPENAI_ISSUER = 'https://auth.openai.com'
const OPENAI_DISCOVERY = `${OPENAI_ISSUER}/.well-known/openid-configuration`
const OPENAI_JWKS = `${OPENAI_ISSUER}/.well-known/jwks.json`
const OPENAI_REVOKE = `${OPENAI_ISSUER}/api/accounts/oauth/revoke`
const KID = 'openai-s3c2-kid'
const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 })

function signedIdToken(
  claims: Record<string, unknown>,
  key: KeyObject,
): string {
  const head = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }),
  ).toString('base64url')
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key)
  return `${head}.${body}.${signature.toString('base64url')}`
}

function idTokenFor(
  clientId: string,
  nonce: string,
  sub = 'user-alpha',
  email = 'alpha@example.com',
): string {
  const now = Math.floor(Date.now() / 1000)
  return signedIdToken(
    {
      iss: OPENAI_ISSUER,
      aud: clientId,
      sub,
      email,
      nonce,
      iat: now,
      exp: now + 600,
    },
    signingKey.privateKey,
  )
}

function fakeOpenAIOAuth(options: {
  issuedClientId: string
  subject?: string
  email?: string
  revokeStatus?: number
}) {
  let authorizeUrl: URL | undefined
  const authorizeCalls: URL[] = []
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input)
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init)
    if (url === OPENAI_DISCOVERY) {
      return new Response(
        JSON.stringify({
          issuer: OPENAI_ISSUER,
          jwks_uri: OPENAI_JWKS,
          revocation_endpoint: OPENAI_REVOKE,
        }),
      )
    }
    if (url === OPENAI_JWKS) {
      return new Response(
        JSON.stringify({
          keys: [
            {
              ...signingKey.publicKey.export({ format: 'jwk' }),
              kid: KID,
              alg: 'RS256',
              use: 'sig',
            },
          ],
        }),
      )
    }
    if (url === OPENAI_REVOKE) {
      return new Response('', { status: options.revokeStatus ?? 200 })
    }
    const idToken = idTokenFor(
      options.issuedClientId,
      authorizeUrl?.searchParams.get('nonce') ?? '',
      options.subject,
      options.email,
    )
    return new Response(
      JSON.stringify({
        access_token: `at-${options.issuedClientId}`,
        refresh_token: `rt-${options.issuedClientId}`,
        id_token: idToken,
        expires_in: 3600,
        scope:
          'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      }),
    )
  }) as typeof fetch

  const interactionFor = (
    promptHandler?: (prompt: AuthPrompt) => Promise<string> | string,
    includeClientIdInRedirect = true,
  ): {
    interaction: AuthInteraction
    prompts: AuthPrompt[]
  } => {
    const prompts: AuthPrompt[] = []
    const interaction: AuthInteraction = {
      signal: new AbortController().signal,
      prompt: async (prompt) => {
        prompts.push(prompt)
        if (prompt.type === 'select' && promptHandler) {
          return promptHandler(prompt)
        }
        return new Promise<string>((_, reject) =>
          prompt.signal?.addEventListener('abort', () =>
            reject(new Error('closed')),
          ),
        )
      },
      notify: (event) => {
        if (event.type !== 'auth_url') return
        const url = new URL(event.url)
        authorizeUrl = url
        authorizeCalls.push(url)
        const redirect = new URL(url.searchParams.get('redirect_uri')!)
        const params = new URLSearchParams({
          code: 'auth-code',
          state: url.searchParams.get('state')!,
        })
        if (includeClientIdInRedirect) {
          params.set('client_id', options.issuedClientId)
        }
        redirect.search = params.toString()
        void realFetch(redirect)
      },
    }
    return { interaction, prompts }
  }

  return { authorizeCalls, interactionFor }
}

test('createRuntime() ephemeral mode runs prompts, streams events/deltas, manages blobs and disposes idempotently', async () => {
  const runtime = createRuntime({
    ephemeral: true,
    mcp: false,
    defaultModel: createFauxModel({
      responses: [fauxText('Hello from isomorphic runtime!')],
    }),
  })

  const events: RuntimeEvent[] = []
  const deltas: StreamDeltaEvent[] = []
  const offEvents = runtime.events.subscribe((ev) => events.push(ev))
  const offDeltas = runtime.events.subscribeDeltas((d) => deltas.push(d))

  try {
    const chat = await runtime.sessions.create({
      id: 'chat-1',
      projectId: null,
      name: 'Direct Chat',
    })
    expect(chat.projectId).toBeNull()
    expect(chat.name).toBe('Direct Chat')

    const stored = await runtime.blobs.storeInbound({
      sessionId: chat.id,
      filename: 'note.txt',
      mimeType: 'text/plain',
      bytes: new TextEncoder().encode('hello blob'),
    })
    expect(await runtime.blobs.get(stored.id)).toMatchObject({
      id: stored.id,
      filename: 'note.txt',
    })
    expect(await runtime.blobs.list(chat.id)).toHaveLength(1)
    expect(new TextDecoder().decode(await runtime.blobs.read(stored.id))).toBe(
      'hello blob',
    )

    const { eventId, inserted } = await runtime.prompt(chat.id, {
      text: 'Say hi',
      dedupeKey: 'req-1',
    })
    expect(eventId).toBeTruthy()
    expect(inserted).toBe(true)

    await runtime.waitForIdle(chat.id)

    const page = await runtime.sessions.messages({ sessionId: chat.id })
    expect(page.messages.length).toBeGreaterThanOrEqual(2)
    expect(
      page.messages.some(
        (m) => m.role === 'assistant' && m.text.includes('isomorphic runtime'),
      ),
    ).toBe(true)

    expect(events.length).toBeGreaterThan(0)
    expect(deltas.length).toBeGreaterThan(0)
    const listed = await runtime.events.list({ sessionId: chat.id })
    expect(listed.length).toBeGreaterThan(0)
    expect(await runtime.events.bufferedDeltas(chat.id)).toEqual([])
    expect(await runtime.recover()).toEqual({
      interruptedJobs: [],
      recoveredRuns: [],
      requeuedInboxRuns: [],
      wokenSessions: [],
    })
  } finally {
    offEvents()
    offDeltas()
    await runtime.dispose()
    await runtime.dispose()
  }
})

test('createRuntime() persistent <agentDir>/vela.db covers projects, sessions, pagination, approvals, steer/stop, timers, subscriptions, bindings, channels', async () => {
  const root = tempRoot('vela-s3c2-runtime-')
  const agentDir = join(root, 'agent')
  const projectDir = join(root, 'workspace')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'keep.txt'), 'keep me')

  let hangStarted!: () => void
  const hangReady = new Promise<void>((resolve) => {
    hangStarted = resolve
  })
  const runtime = createRuntime({
    agentDir,
    mcp: false,
    trustOverride: () => true,
    tools: [
      {
        name: 'custom_echo',
        description: 'Echoes text after approval',
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => `echo:${text}`,
      },
    ],
    toolApprovalCheck: (toolName) =>
      toolName === 'custom_echo'
        ? { requireApproval: true, summary: 'Approve custom_echo?' }
        : undefined,
    defaultModel: createFauxModel({
      responses: [
        fauxToolCall('custom_echo', { text: 'approved-payload' }),
        fauxText('After approval done'),
        fauxText('Second turn'),
        fauxText('Steer turn'),
        () => {
          hangStarted()
          return fauxHang()
        },
      ],
    }),
  })

  let unregisterDone = false
  const channel: ChannelAdapter = {
    name: 'mockchan',
    async start() {},
    async stop() {
      unregisterDone = true
    },
    async deliver() {
      return { externalMessageId: 'ext-1' }
    },
  }

  try {
    expect(runtime.agentDir).toBe(agentDir)
    expect(existsSync(join(agentDir, 'vela.db'))).toBe(true)

    await runtime.registerChannel(channel)
    await runtime.unregisterChannel('mockchan')
    expect(unregisterDone).toBe(true)

    const proj = await runtime.projects.create({
      name: 'Proj A',
      cwd: projectDir,
    })
    expect((await runtime.projects.get(proj.id))?.name).toBe('Proj A')
    expect((await runtime.projects.getByCwd(projectDir))?.id).toBe(proj.id)
    expect(await runtime.projects.list()).toHaveLength(1)
    expect(
      (await runtime.projects.update(proj.id, { name: 'Proj Alpha' })).name,
    ).toBe('Proj Alpha')

    const sess = await runtime.sessions.create({
      id: 'sess-main',
      projectId: proj.id,
    })
    const renamed = await runtime.sessions.rename(sess.id, 'Main Work')
    expect(renamed.name).toBe('Main Work')

    // Approval suspension & resolution
    await runtime.prompt(sess.id, { text: 'Run custom_echo please' })
    await runtime.waitForIdle(sess.id)
    const pending = await runtime.approvals.list(sess.id)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.summary).toBe('Approve custom_echo?')

    const resolution = await runtime.approvals.resolve({
      approvalId: pending[0]!.id,
      decision: 'approved',
      decidedBy: 'liam',
    })
    expect(resolution.shouldWake).toBe(true)
    await runtime.waitForIdle(sess.id)
    expect(await runtime.approvals.list(sess.id)).toHaveLength(0)

    const afterApprovalMsgs = await runtime.sessions.messages({
      sessionId: sess.id,
    })
    expect(
      afterApprovalMsgs.messages.some(
        (m) => m.role === 'assistant' && m.text.includes('After approval done'),
      ),
    ).toBe(true)

    // Message cursor pagination
    await runtime.prompt(sess.id, { text: 'Another turn' })
    await runtime.waitForIdle(sess.id)
    const page1 = await runtime.sessions.messages({
      sessionId: sess.id,
      limit: 2,
    })
    expect(page1.messages).toHaveLength(2)
    expect(page1.nextCursor).toBeDefined()
    const page2 = await runtime.sessions.messages({
      sessionId: sess.id,
      cursor: page1.nextCursor,
      limit: 2,
    })
    expect(page2.messages.length).toBeGreaterThan(0)
    expect(page2.messages[0]!.seq).toBeGreaterThan(page1.messages.at(-1)!.seq)

    // Steer while idle queues steer & status reflects session
    await runtime.steer(sess.id, 'Steer note')
    await runtime.waitForIdle(sess.id)
    expect((await runtime.sessions.status(sess.id)).session.id).toBe(sess.id)

    // Stop an active hanging run
    await runtime.prompt(sess.id, { text: 'Hang now' })
    await hangReady
    expect(await runtime.stop(sess.id, 'cancel hang')).toBe(true)
    await runtime.waitForIdle(sess.id)

    // Timers, subscriptions, bindings CRUD
    const routine = await runtime.timers.createRoutine({
      projectId: proj.id,
      sessionId: sess.id,
      message: 'Daily ping',
      schedule: { time: '09:00' },
      timezone: 'UTC',
    })
    const followup = await runtime.timers.createFollowup({
      projectId: proj.id,
      sessionId: sess.id,
      message: 'Follow up',
      fireAt: new Date(Date.now() + 60_000).toISOString(),
    })
    expect(await runtime.timers.list({ sessionId: sess.id })).toHaveLength(2)
    expect(
      (await runtime.timers.update(routine.id, { enabled: false }))?.enabled,
    ).toBe(false)
    expect(await runtime.timers.delete(followup.id)).toBe(true)

    const sub = await runtime.subscriptions.create({
      source: 'github',
      eventKey: 'pr:opened',
      projectId: proj.id,
      sessionId: sess.id,
    })
    expect(
      await runtime.subscriptions.list({ sessionId: sess.id }),
    ).toHaveLength(1)
    expect(await runtime.subscriptions.remove(sub.id)).toBe(true)

    const binding = await runtime.bindings.upsert({
      channel: 'mockchan',
      externalId: 'chat_1',
      kind: 'group',
      projectId: proj.id,
      sessionId: sess.id,
    })
    expect((await runtime.bindings.get(binding.id))?.externalId).toBe('chat_1')
    expect(
      (await runtime.bindings.setEnabled(binding.id, false))?.enabled,
    ).toBe(false)
    expect(await runtime.bindings.list({ channel: 'mockchan' })).toHaveLength(1)
    expect(await runtime.bindings.remove(binding.id)).toBe(true)

    // Reset & delete session + remove project without deleting workspace on disk
    expect(sess.id).toBeTruthy()
    expect((await runtime.sessions.get(sess.id))?.leafMessageId).not.toBeNull()
    const resetSess = await runtime.sessions.reset(sess.id)
    expect(resetSess.id).toBe(sess.id)
    expect(resetSess.leafMessageId).toBeNull()
    expect(resetSess.state).toBe('idle')
    expect(await runtime.sessions.delete(resetSess.id)).toBe(true)
    expect(await runtime.projects.remove(proj.id)).toBe(true)
    expect(existsSync(join(projectDir, 'keep.txt'))).toBe(true)
  } finally {
    await runtime.dispose()
  }
})

test('ModelInfo.planLabel is computed dynamically across list/available/resolve without mutating catalog', async () => {
  const credentials = memoryCredentialStore()
  const providers: Record<string, ProviderDefinition> = {
    openai: {
      oauth: openaiChatGPTLogin,
      apiKeyLogin: true,
      authSource: (c) => c?.type,
      models: [{ id: 'gpt-5.2', name: 'GPT-5.2' }],
      createModel: () => createFauxModel(),
    },
  }
  const registry = new ModelRegistry(providers, credentials)

  expect(
    registry.list().find((m) => m.ref === 'openai/gpt-5.2')?.planLabel,
  ).toBeUndefined()
  expect(registry.available()).toEqual([])
  expect(registry.resolve('openai/gpt-5.2').info.planLabel).toBeUndefined()

  await credentials.modify('openai', async () => ({
    type: 'oauth',
    access: 'at',
    refresh: 'rt',
    expires: Date.now() + 3_600_000,
    clientId: 'oaiapp_1',
    subject: 'user-1',
  }))

  expect(
    registry.list().find((m) => m.ref === 'openai/gpt-5.2')?.planLabel,
  ).toBe('ChatGPT plan')
  expect(
    registry.available().find((m) => m.ref === 'openai/gpt-5.2')?.planLabel,
  ).toBe('ChatGPT plan')
  expect(registry.resolve('openai/gpt-5.2').info.planLabel).toBe('ChatGPT plan')

  // Channel sessions block localOnly OAuth so planLabel is withheld dynamically
  expect(
    registry.list('lark').find((m) => m.ref === 'openai/gpt-5.2')?.planLabel,
  ).toBeUndefined()
  expect(
    registry.resolve('openai/gpt-5.2', { channel: () => 'lark' }).info
      .planLabel,
  ).toBeUndefined()

  // Switching back to API key or logging out removes planLabel immediately
  await credentials.modify('openai', async () => ({
    type: 'api_key',
    key: 'sk-test',
  }))
  expect(
    registry.list().find((m) => m.ref === 'openai/gpt-5.2')?.planLabel,
  ).toBeUndefined()
  await registry.logout('openai')
  expect(
    registry.list().find((m) => m.ref === 'openai/gpt-5.2')?.planLabel,
  ).toBeUndefined()
})

test('oauth_registrations persists client registration across logout, supports reuse vs switch, --forget, and LogoutResult.notice', async () => {
  const db = openDatabase({ path: ':memory:' })
  const registrations = new SqliteOAuthRegistrationStore(db)
  const credentials = memoryCredentialStore()
  const registry = new ModelRegistry(
    {
      openai: {
        oauth: openaiChatGPTLogin,
        apiKeyLogin: true,
        authSource: (c) => c?.type,
        models: [{ id: 'gpt-5.2', name: 'GPT-5.2' }],
        createModel: () => createFauxModel(),
      },
    },
    credentials,
    registrations,
  )

  try {
    // 1. First login saves both credential and oauth_registrations row
    const first = fakeOpenAIOAuth({
      issuedClientId: 'oaiapp_first',
      subject: 'sub-alpha',
      email: 'alpha@example.com',
    })
    const firstUi = first.interactionFor()
    await registry.login('openai', 'oauth', firstUi.interaction, {
      getDeviceId: () => DEVICE,
    })
    expect(registrations.get('openai')).toMatchObject({
      clientId: 'oaiapp_first',
      hostId: DEVICE,
      subject: 'sub-alpha',
    })

    // 2. Normal logout removes credential but retains oauth_registrations
    expect(await registry.logout('openai')).toEqual({ removed: true })
    expect(credentials.get('openai')).toBeUndefined()
    expect(registry.loginProviders()[0]?.source).toBeUndefined()
    expect(registrations.get('openai')?.clientId).toBe('oaiapp_first')

    // 3. Re-login choosing 'reuse' sends saved clientId without id_token_hint/login_hint
    const reuse = fakeOpenAIOAuth({
      issuedClientId: 'oaiapp_first',
      subject: 'sub-alpha',
    })
    const reuseUi = reuse.interactionFor(async (prompt) => {
      if (prompt.type !== 'select') throw new Error('Expected select prompt')
      expect(prompt.options.map((o) => o.id)).toEqual(['reuse', 'switch'])
      return 'reuse'
    }, false)
    await registry.login('openai', 'oauth', reuseUi.interaction, {
      getDeviceId: () => DEVICE,
    })
    expect(reuseUi.prompts.filter((p) => p.type === 'select')).toHaveLength(1)
    expect(reuse.authorizeCalls[0]?.searchParams.get('client_id')).toBe(
      'oaiapp_first',
    )
    expect(reuse.authorizeCalls[0]?.searchParams.has('id_token_hint')).toBe(
      false,
    )
    expect(reuse.authorizeCalls[0]?.searchParams.has('login_hint')).toBe(false)

    // 4. Logout then mismatch subject on 'reuse' fails closed with --forget guidance
    await registry.logout('openai')
    const wrongAccount = fakeOpenAIOAuth({
      issuedClientId: 'oaiapp_first',
      subject: 'sub-other',
    })
    const wrongUi = wrongAccount.interactionFor(undefined, false)
    await expect(
      registry.login('openai', 'oauth', wrongUi.interaction, {
        getDeviceId: () => DEVICE,
        accountMode: 'reuse',
      }),
    ).rejects.toThrow(/--forget/)

    // 5. Choosing 'switch' drops clientId back to dynamic_agent_client and overwrites registration
    const switched = fakeOpenAIOAuth({
      issuedClientId: 'oaiapp_second',
      subject: 'sub-beta',
      email: 'beta@example.com',
      revokeStatus: 500,
    })
    const switchUi = switched.interactionFor()
    await registry.login('openai', 'oauth', switchUi.interaction, {
      getDeviceId: () => DEVICE,
      accountMode: 'switch',
    })
    expect(switched.authorizeCalls[0]?.searchParams.get('client_id')).toBe(
      'dynamic_agent_client',
    )
    expect(
      switched.authorizeCalls[0]?.searchParams.get('agent_name_hint'),
    ).toBe('Vela')
    expect(registrations.get('openai')).toMatchObject({
      clientId: 'oaiapp_second',
      subject: 'sub-beta',
    })

    // 6. Logout with revoke 500 + forget: true returns notice, removed: true, forgotten: true
    const logoutForgotten = await registry.logout('openai', { forget: true })
    expect(logoutForgotten.removed).toBe(true)
    expect(logoutForgotten.forgotten).toBe(true)
    expect(logoutForgotten.notice).toContain('revoked')
    expect(registrations.get('openai')).toBeUndefined()

    // 7. Forget on already-logged-out provider cleans lingering registration
    registrations.set('openai', { clientId: 'oaiapp_stale', hostId: DEVICE })
    expect(await registry.logout('openai', { forget: true })).toEqual({
      removed: false,
      forgotten: true,
    })
    expect(registrations.get('openai')).toBeUndefined()
  } finally {
    db.close()
  }
})

test('Round 1 regressions: prompt routing, run_finished steer fallback, and active-branch message queries', async () => {
  const root = tempRoot('vela-s3c2-reg1-')
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir, { recursive: true })
  const db = openDatabase({ path: join(agentDir, 'vela.db') })

  let steerableTurnReady!: () => void
  const canSteer = new Promise<void>((r) => {
    steerableTurnReady = r
  })
  let releaseTool!: () => void
  const toolDone = new Promise<void>((r) => {
    releaseTool = r
  })

  const runtime = createRuntime({
    db,
    agentDir,
    mcp: false,
    tools: [
      {
        name: 'slow_probe',
        description: 'Waits for release',
        inputSchema: z.object({}),
        execute: async () => {
          steerableTurnReady()
          await toolDone
          return 'probe-ok'
        },
      },
    ],
    defaultModel: createFauxModel({
      responses: [
        fauxToolCall('slow_probe', {}),
        fauxText('turn1-after-steer'),
        fauxText('run-finished-followup'),
      ],
    }),
  })

  let followupDone!: () => void
  const followupPromise = new Promise<void>((r) => {
    followupDone = r
  })
  let finishedCount = 0
  let sentOnFinished = false
  const off = runtime.events.subscribe((ev) => {
    if (ev.type === 'run_finished' && ev.sessionId === 'sess-a') {
      finishedCount += 1
      if (!sentOnFinished) {
        sentOnFinished = true
        void runtime.steer('sess-a', 'late-steer-becomes-prompt')
      } else if (finishedCount >= 2) {
        followupDone()
      }
    }
  })

  try {
    await runtime.sessions.create({ id: 'sess-a', projectId: null })
    await runtime.sessions.create({ id: 'sess-b', projectId: null })

    // P1-1: extra sessionId inside input must not reroute prompt('sess-a', ...) to 'sess-b'
    const bogusPayload = {
      text: 'Trigger slow tool',
      sessionId: 'sess-b',
    } as unknown as Parameters<typeof runtime.prompt>[1]
    await runtime.prompt('sess-a', bogusPayload)
    expect(
      (await runtime.sessions.messages({ sessionId: 'sess-b' })).messages,
    ).toEqual([])

    // P1-2: in-turn steer AND run_finished listener steer fallback both deliver cleanly
    await canSteer
    await runtime.steer('sess-a', 'mid-turn-steer')
    releaseTool()
    await followupPromise
    await runtime.waitForIdle('sess-a')

    const msgs = (await runtime.sessions.messages({ sessionId: 'sess-a' }))
      .messages
    expect(msgs.some((m) => m.text.includes('turn1-after-steer'))).toBe(true)
    expect(msgs.some((m) => m.text.includes('run-finished-followup'))).toBe(
      true,
    )

    // P1-7: custom_message preserves customType/display, abandoned branches are ignored, reset clears messages()
    const parentId = msgs[0]!.id
    db.run(
      `INSERT INTO vela_messages (session_id, id, parent_id, seq, kind, role, content_json, created_at)
       VALUES (?, ?, ?, ?, 'custom_message', 'user', ?, ?)`,
      'sess-a',
      'abandoned-branch-leaf',
      parentId,
      999,
      JSON.stringify({
        customType: 'memory',
        display: false,
        content: 'hidden-secret',
      }),
      new Date().toISOString(),
    )
    const afterBranch = (
      await runtime.sessions.messages({ sessionId: 'sess-a' })
    ).messages
    expect(afterBranch.some((m) => m.id === 'abandoned-branch-leaf')).toBe(
      false,
    )

    // Point leaf_message_id at custom_message to verify customType/display metadata preservation
    db.run(
      'UPDATE sessions SET leaf_message_id = ? WHERE id = ?',
      'abandoned-branch-leaf',
      'sess-a',
    )
    const onCustomBranch = (
      await runtime.sessions.messages({ sessionId: 'sess-a' })
    ).messages
    const customMsg = onCustomBranch.find(
      (m) => m.id === 'abandoned-branch-leaf',
    )
    expect(customMsg).toMatchObject({
      kind: 'custom_message',
      customType: 'memory',
      display: false,
      text: 'hidden-secret',
    })

    await runtime.sessions.reset('sess-a')
    expect(
      (await runtime.sessions.messages({ sessionId: 'sess-a' })).messages,
    ).toEqual([])
  } finally {
    off()
    await runtime.dispose()
    db.close()
  }
})

test('Round 1 regressions: resume restores saved location on failure, offline export/tree works, async rejections, and channel/handle enforcement', async () => {
  const root = tempRoot('vela-s3c2-reg2-')
  const agentDir = join(root, 'agent')
  const projectDir = join(root, 'proj')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })

  // P2-1 & P2-2: offline navigateTree / exportHtml without model; async rejections for continueInterrupted & clone
  const vOffline = createVela({ cwd: projectDir, providers: {} })
  try {
    const offSession = vOffline.session('offline')
    await expect(offSession.continueInterrupted()).rejects.toThrow(
      /No saved turn/,
    )
    await expect(offSession.clone()).rejects.toThrow(/Nothing to clone yet/)
    offSession.append({ role: 'user', content: 'first' })
    const leaf1 = offSession.getLeafId()!
    offSession.append({ role: 'user', content: 'second' })
    const nav = await offSession.navigateTree(leaf1, { summarize: false })
    expect(nav.cancelled).toBe(false)
    const htmlPath = join(root, 'out.html')
    await offSession.exportHtml(htmlPath)
    expect(existsSync(htmlPath)).toBe(true)
  } finally {
    await vOffline.dispose()
  }

  // P1-3: resume() restores saved location authoritatively even when remote environment fails to prepare
  const sharedDb = openDatabase({ path: ':memory:' })
  const vWrite = createVela({
    db: sharedDb,
    cwd: projectDir,
    model: createFauxModel(),
  })
  const sWrite = vWrite.session('relocate-fail')
  sWrite.append({ role: 'user', content: 'hi' })
  await sWrite.store.persistLocation({
    environment: 'container-a',
    cwd: '/workspace',
  })
  await sWrite.save()
  await vWrite.dispose()

  const vFail = createVela({
    db: sharedDb,
    cwd: projectDir,
    model: createFauxModel(),
    env: () => undefined,
  })
  const sFail = vFail.session('relocate-fail')
  try {
    await expect(sFail.resume()).rejects.toThrow(/unavailable/)
    expect(sFail.location).toEqual({
      environment: 'container-a',
      cwd: '/workspace',
    })
  } finally {
    await vFail.dispose()
    sharedDb.close()
  }

  // P1-4 & P2-8 & P2-6: channel available()/defaultRef() filter localOnly OAuth, pre-resolved handle cannot bypass on channel, environments load cleanly
  const creds = memoryCredentialStore()
  await creds.modify('openai', async () => ({
    type: 'oauth',
    access: 'at',
    refresh: 'rt',
    expires: Date.now() + 3_600_000,
    clientId: 'oaiapp_1',
    subject: 'user-1',
  }))
  const providers: Record<string, ProviderDefinition> = {
    openai: {
      oauth: openaiChatGPTLogin,
      authSource: (c) =>
        c?.type === 'oauth' ? 'OAuth (auth.json)' : undefined,
      models: [{ id: 'gpt-5.2', name: 'GPT-5.2' }],
      createModel: (_id, ctx) => {
        const base = createFauxModel({ responses: [fauxText('ok')] })
        return {
          ...base,
          doStream: async (params: Parameters<typeof base.doStream>[0]) => {
            if (!(await ctx.credential())) {
              throw new Error('Credential withheld on channel')
            }
            return base.doStream(params)
          },
        }
      },
    },
  }
  const localVela = createVela({
    providers,
    credentials: creds,
    model: 'openai/gpt-5.2',
  })
  try {
    expect(localVela.models({ channel: 'lark' })).toEqual([])
    const preResolvedHandle = localVela.model
    const chanSess = localVela.session('chan-sess', {
      channel: 'lark',
      model: preResolvedHandle,
    })
    // Re-resolved channel session blocks localOnly OAuth instead of reusing local handle's credential context
    await expect(chanSess.prompt('hi')).rejects.toThrow(
      /Credential withheld on channel/,
    )

    // P2-6: createRuntime accepts declarative environments map cleanly without EnvironmentRegistry import
    const runtime = createRuntime({
      ephemeral: true,
      mcp: false,
      providers,
      credentials: creds,
      defaultModel: preResolvedHandle,
      environments: {
        sandbox: { image: 'alpine:3.20', network: 'off' },
      },
    })
    try {
      const chat = await runtime.sessions.create({
        id: 'chan-rt',
        projectId: null,
      })
      await runtime.bindings.upsert({
        channel: 'lark',
        externalId: 'c1',
        kind: 'group',
        sessionId: chat.id,
      })
      await runtime.prompt(chat.id, { text: 'test channel block' })
      await runtime.waitForIdle(chat.id)
      expect((await runtime.sessions.status(chat.id)).session.state).not.toBe(
        'running',
      )
    } finally {
      await runtime.dispose()
    }
  } finally {
    await localVela.dispose()
  }
})

test('Round 1 regressions: --no-session --forget clears persistent vela.db registration, atomic rollback, backfill, and hostId check', async () => {
  const root = tempRoot('vela-s3c2-reg3-')
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir, { recursive: true })
  const dbPath = join(agentDir, 'vela.db')
  const authPath = join(agentDir, 'auth.json')

  // Seed persistent installation vela.db + legacy OAuth credential without registration row
  const seedDb = openDatabase({ path: dbPath })
  seedDb.close()
  const diskCreds = fileCredentialStore(authPath)
  await diskCreds.modify('openai', async () => ({
    type: 'oauth',
    access: 'at-legacy',
    refresh: 'rt-legacy',
    expires: Date.now() + 3_600_000,
    clientId: 'oaiapp_legacy',
    subject: 'sub-legacy',
  }))

  // P1-5 & P2-7: --no-session ordinary logout backfills registration into persistent <agentDir>/vela.db; --forget removes it
  const cliNoSess = createVela({
    agentDir,
    ephemeralSessions: true,
    credentials: diskCreds,
    providers: {
      openai: {
        oauth: openaiChatGPTLogin,
        authSource: (c) => c?.type,
        models: [{ id: 'gpt-5.2' }],
        createModel: () => createFauxModel(),
      },
    },
  })
  fakeOpenAIOAuth({ issuedClientId: 'oaiapp_legacy', subject: 'sub-legacy' })
  try {
    expect(await cliNoSess.logout('openai')).toEqual({ removed: true })
    expect(cliNoSess.loginProviders()[0]?.hasRegistration).toBe(true)

    const verifyDb = openDatabase({ path: dbPath, readonly: true })
    try {
      expect(
        new SqliteOAuthRegistrationStore(verifyDb).get('openai'),
      ).toMatchObject({
        clientId: 'oaiapp_legacy',
        subject: 'sub-legacy',
      })
    } finally {
      verifyDb.close()
    }

    expect(await cliNoSess.logout('openai', { forget: true })).toEqual({
      removed: false,
      forgotten: true,
    })
    expect(cliNoSess.loginProviders()[0]?.hasRegistration).toBeUndefined()
  } finally {
    await cliNoSess.dispose()
  }

  // P1-6 & P2-7: getDeviceId called once, failed registration write keeps credential unwritten, mismatched hostId skips reuse
  let deviceCalls = 0
  const memCreds = memoryCredentialStore()
  const throwingRegStore = {
    get: () => ({
      clientId: 'oaiapp_other_host',
      hostId: '11111111-1111-4111-8111-111111111111',
      subject: 'sub-a',
    }),
    set: () => {
      throw new Error('sqlite read-only failure')
    },
    delete: () => false,
  }
  const failRegRegistry = new ModelRegistry(
    {
      openai: {
        oauth: openaiChatGPTLogin,
        authSource: (c) => c?.type,
        models: [{ id: 'gpt-5.2' }],
        createModel: () => createFauxModel(),
      },
    },
    memCreds,
    throwingRegStore,
  )
  const freshFlow = fakeOpenAIOAuth({
    issuedClientId: 'oaiapp_new',
    subject: 'sub-new',
  })
  const ui = freshFlow.interactionFor()
  await expect(
    failRegRegistry.login('openai', 'oauth', ui.interaction, {
      getDeviceId: () => {
        deviceCalls += 1
        return DEVICE
      },
    }),
  ).rejects.toThrow('sqlite read-only failure')
  expect(deviceCalls).toBe(1)
  expect(memCreds.get('openai')).toBeUndefined()
  expect(freshFlow.authorizeCalls[0]?.searchParams.get('client_id')).toBe(
    'dynamic_agent_client',
  )
})

test('Round 1 regressions: emitted package declarations expose zero SessionScope or .scope surface', async () => {
  const distRoot = join(import.meta.dir, '../../dist')
  for (const rel of [
    'index.d.ts',
    'extension-api.d.ts',
    'driver/vela-session.d.ts',
    'driver/tools/registry.d.ts',
    'driver/tools/types.d.ts',
  ]) {
    const text = await Bun.file(join(distRoot, rel)).text()
    expect(text).not.toContain('SessionScope')
    expect(text).not.toMatch(/\bscope\s*[?:]/)
    expect(text).not.toMatch(/\bget scope\s*\(/)
  }
  const optionsDts = await Bun.file(
    join(distRoot, 'driver/session/options.d.ts'),
  ).text()
  const sessionOptionsBlock = optionsDts.match(
    /export interface SessionOptions \{[\s\S]*?\n\}/,
  )?.[0]
  expect(sessionOptionsBlock).toBeDefined()
  expect(sessionOptionsBlock).not.toContain('SessionScope')
  expect(sessionOptionsBlock).not.toMatch(/\bscope\s*[?:]/)
})
