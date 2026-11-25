import { afterEach, expect, test } from 'bun:test'
import { lookup } from 'node:dns/promises'
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { APICallError } from '@ai-sdk/provider'
import { z } from 'zod'
import { local } from '../../packages/vela/src/legacy-channels/index.ts'
import type { LocalEventData } from '../../packages/vela/src/legacy-channels/local-protocol.ts'
import { drainChannels } from '../../packages/vela/src/legacy-channels/testing.ts'
import {
  type FauxRequest,
  fauxError,
  fauxHang,
  fauxText,
  fauxToolCall,
} from '../../packages/vela/src/testing/core/index.ts'
import {
  freeLocalPort,
  LOCAL_TOKEN,
  LocalClient,
  type Project,
  type Snapshot,
  sessionPath,
  until,
  type VisibleMessage,
  watchLocal,
} from '../support/local.ts'
import {
  cleanupTestVelas,
  createTestVela,
  type TestVelaOptions,
} from '../support/vela.ts'

afterEach(cleanupTestVelas)

async function setup(options: TestVelaOptions = {}) {
  const port = await freeLocalPort()
  const t = createTestVela({
    ...options,
    extensions: [
      ...(options.extensions ?? []),
      local({ token: LOCAL_TOKEN, port }),
    ],
  })
  await t.vela.startChannels()
  const client = new LocalClient(`http://127.0.0.1:${port}`, LOCAL_TOKEN)
  return { t, client, port }
}

async function messages(
  client: LocalClient,
  project: Project,
  sessionId?: string,
) {
  return (
    await client.request<{ messages: VisibleMessage[] }>(
      `${sessionPath(project, sessionId)}/messages`,
    )
  ).messages
}

function taskRouter(req: FauxRequest) {
  if (req.tools.includes('channel_start_topic')) {
    // The project chat runs quick work itself but still dispatches a longer task (#421).
    expect(req.tools).toContain('write')
    // Waiting for a decision stays a topic control.
    expect(req.tools).not.toContain('channel_wait_for_input')
    if (req.lastUserText.includes('status now'))
      return fauxText('Status received')
    return req.toolResults.length
      ? fauxText('Dispatched')
      : fauxToolCall('channel_start_topic', {
          title: 'Write result',
          brief: 'Write result.txt in this project',
        })
  }
  expect(req.tools).toContain('write')
  expect(req.tools).toContain('channel_wait_for_input')
  return req.toolResults.length
    ? fauxText('Task file is ready')
    : {
        reasoning: 'HIDDEN_THINKING_713',
        toolCalls: [
          {
            name: 'write',
            input: { path: 'result.txt', content: 'PRIVATE_TOOL_ARGUMENT_713' },
          },
        ],
      }
}

test('real Local HTTP opens canonical projects and rejects unauthenticated or malformed requests without model work', async () => {
  const { t, client, port } = await setup()
  let external: { address: string } | undefined
  try {
    external = Object.values(networkInterfaces())
      .flat()
      .find(
        (address) => address && address.family === 'IPv4' && !address.internal,
      )
  } catch {
    // Restricted containers can deny getifaddrs; resolve only this machine's hostname instead.
    const address = await lookup(hostname(), { family: 4 }).catch(
      () => undefined,
    )
    if (address && !address.address.startsWith('127.')) external = address
  }
  if (external)
    await expect(
      fetch(`http://${external.address}:${port}/v1/info`, {
        headers: { Authorization: `Bearer ${LOCAL_TOKEN}` },
        signal: AbortSignal.timeout(500),
      }),
    ).rejects.toThrow()
  const paths = ['/v1/info', '/v1/projects', '/v1/events']
  for (const path of paths) {
    for (const token of ['', 'wrong']) {
      const response = await fetch(`${client.url}${path}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      expect(response.status).toBe(401)
      expect(await response.text()).not.toContain(LOCAL_TOKEN)
    }
  }
  const info = await client.request<{
    version: number
    channel: string
    deploymentId: string
  }>('/v1/info')
  expect(info).toMatchObject({ version: 1, channel: 'local' })
  expect(info.deploymentId).toBeTruthy()
  const project = await client.request<Project>('/v1/projects', {
    cwd: t.cwd,
    name: 'First',
  })
  const alias = join(t.cwd, 'alias')
  symlinkSync(t.cwd, alias, 'dir')
  expect(
    (await client.request<Project>('/v1/projects', { cwd: alias })).id,
  ).toBe(project.id)
  expect(project.channel).toBe('local')
  expect(project.id).not.toContain(t.cwd)
  for (const body of ['{', JSON.stringify({ cwd: t.cwd, tools: ['bash'] })]) {
    const response = await fetch(`${client.url}/v1/projects`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LOCAL_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body,
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toHaveProperty('error.code')
  }
  for (const body of [
    { text: '' },
    { text: 'x', mode: 'steer', runId: 'stale' },
    { text: 'x', cwd: '/tmp' },
  ]) {
    const response = await fetch(
      `${client.url}${sessionPath(project)}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${LOCAL_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    )
    expect(response.status).toBe(400)
  }
  const oversized = await fetch(
    `${client.url}${sessionPath(project)}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LOCAL_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: 'x'.repeat(1024 * 1024 + 1) }),
    },
  )
  expect(oversized.status).toBe(413)
  const queryToken = await fetch(`${client.url}/v1/info?token=${LOCAL_TOKEN}`)
  expect(queryToken.status).toBe(401)
  const cors = await fetch(`${client.url}/v1/info`, {
    headers: {
      Authorization: `Bearer ${LOCAL_TOKEN}`,
      Origin: 'https://untrusted.example',
    },
  })
  expect(cors.headers.get('access-control-allow-origin')).toBeNull()
  expect(t.model.calls).toHaveLength(0)
  expect(await messages(client, project)).toEqual([])
})

test('project chat opens a real task, writes in its cwd and streams only visible allowlisted events and one completion status', async () => {
  const { t, client } = await setup({
    responses: Array(20).fill(taskRouter),
    allowPendingResponses: true,
  })
  const projectCwd = join(t.cwd, 'project')
  mkdirSync(projectCwd)
  const project = await client.request<Project>('/v1/projects', {
    cwd: projectCwd,
  })
  const watch = await watchLocal(client, project.id)
  try {
    expect(watch.events[0]?.event).toBe('reset')
    const receipt = await client.request<{
      sessionId: string
      messageId: string
    }>(`${sessionPath(project)}/messages`, {
      text: 'Please write the result',
      clientMessageId: 'client-1',
    })
    expect(receipt.sessionId).toBe(project.sessionId)
    expect(receipt.messageId).toBeTruthy()
    await until(
      () => watch.events.some((event) => event.event === 'status'),
      'task status',
    )
    await drainChannels(t.vela)
    const sessions = (
      await client.request<{ sessions: Snapshot[] }>(
        `/v1/projects/${project.id}/sessions`,
      )
    ).sessions
    const task = sessions.find((session) => session.topic)
    expect(task).toBeDefined()
    await until(
      () =>
        watch.events.some((event) => {
          const envelope = event.data as {
            sessionId?: string
            data?: { state?: string }
          }
          return (
            event.event === 'session' &&
            envelope.sessionId === task!.sessionId &&
            envelope.data?.state === 'done'
          )
        }),
      'settled task SSE snapshot',
    )
    expect(readFileSync(join(projectCwd, 'result.txt'), 'utf8')).toBe(
      'PRIVATE_TOOL_ARGUMENT_713',
    )
    expect(await messages(client, project, task!.sessionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          text: 'Task file is ready',
        }),
      ]),
    )
    expect((await messages(client, project))[0]).toMatchObject({
      text: 'Please write the result',
      clientMessageId: 'client-1',
    })
    const wire = JSON.stringify(watch.events)
    expect(wire).not.toContain('HIDDEN_THINKING_713')
    expect(wire).not.toContain('PRIVATE_TOOL_ARGUMENT_713')
    expect(wire).not.toContain(LOCAL_TOKEN)
    expect(
      watch.events.filter((event) => event.event === 'status'),
    ).toHaveLength(1)
    const hubBefore = t.model.calls.filter((call) =>
      call.tools.includes('channel_start_topic'),
    ).length
    expect(hubBefore).toBe(2) // Initial dispatch and its tool continuation only.
    await client.request(`${sessionPath(project)}/messages`, {
      text: 'status now',
    })
    await until(async () =>
      (await messages(client, project)).some(
        (message) => message.text === 'Status received',
      ),
    )
    await drainChannels(t.vela)
    expect(
      t.model.calls.filter((call) =>
        call.tools.includes('channel_start_topic'),
      ),
    ).toHaveLength(hubBefore + 1)
    expect(JSON.stringify(t.model.calls.at(-1)?.prompt)).toContain(
      'Task file is ready',
    )
  } finally {
    await watch.close()
  }
})

test('disconnected completion, visible pagination and project identity survive restart without mixing projects', async () => {
  const { t, client } = await setup({
    responses: [fauxText('Visible first'), fauxText('Visible second')],
  })
  const a = await client.request<Project>('/v1/projects', { cwd: t.cwd })
  const bCwd = join(t.cwd, 'b')
  mkdirSync(bCwd)
  const b = await client.request<Project>('/v1/projects', { cwd: bCwd })
  const watch = await watchLocal(client, a.id)
  await watch.close()
  await client.request(`${sessionPath(a)}/messages`, {
    text: 'First',
    clientMessageId: 'correlation-only',
  })
  await until(async () =>
    (await messages(client, a)).some(
      (message) => message.text === 'Visible first',
    ),
  )
  await client.request(`${sessionPath(a)}/messages`, {
    text: 'Second',
    clientMessageId: 'correlation-only',
  })
  await until(async () =>
    (await messages(client, a)).some(
      (message) => message.text === 'Visible second',
    ),
  )
  await drainChannels(t.vela)
  const all = await messages(client, a)
  expect(await messages(client, b)).toEqual([])
  const cross = await fetch(
    `${client.url}${sessionPath(b, a.sessionId)}/messages`,
    { headers: { Authorization: `Bearer ${LOCAL_TOKEN}` } },
  )
  expect(cross.status).toBe(404)
  const page = await client.request<{
    messages: VisibleMessage[]
    nextCursor?: string
  }>(`${sessionPath(a)}/messages?limit=1`)
  expect(page.messages).toEqual(all.slice(0, 1))
  const next = await client.request<{ messages: VisibleMessage[] }>(
    `${sessionPath(a)}/messages?limit=1&after=${page.messages[0]!.id}`,
  )
  expect(next.messages).toEqual(all.slice(1, 2))
  await t.vela.dispose()
  const restarted = await setup({ cwd: t.cwd })
  const reopened = await restarted.client.request<Project>('/v1/projects', {
    cwd: t.cwd,
  })
  expect(reopened.id).toBe(a.id)
  expect(await messages(restarted.client, reopened)).toEqual(all)
  const reconnect = await watchLocal(restarted.client, a.id)
  expect(reconnect.events[0]?.event).toBe('reset')
  await reconnect.close()
})

test('Stop requires the current run and cannot stop later work', async () => {
  const { t, client } = await setup({
    responses: [
      fauxHang('private thinking'),
      fauxText('Queued survived'),
      fauxText('Recovered'),
    ],
  })
  const project = await client.request<Project>('/v1/projects', { cwd: t.cwd })
  await client.request(`${sessionPath(project)}/messages`, { text: 'Hang' })
  await until(() => t.model.calls.length === 1)
  const session = (
    await client.request<{ sessions: Snapshot[] }>(
      `/v1/projects/${project.id}/sessions`,
    )
  ).sessions[0]!
  expect(session.runId).toBeTruthy()
  await client.request(`${sessionPath(project)}/messages`, {
    text: 'Queued before Stop',
  })
  const stop = await client.request(`${sessionPath(project)}/stop`, {
    runId: session.runId,
  })
  expect(stop).toEqual({ stopped: true })
  await drainChannels(t.vela)
  expect(
    (await messages(client, project)).some(
      (message) => message.text === 'Queued survived',
    ),
  ).toBe(true)
  const stale = await fetch(`${client.url}${sessionPath(project)}/stop`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LOCAL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ runId: session.runId }),
  })
  expect(stale.status).toBe(409)
  await client.request(`${sessionPath(project)}/messages`, { text: 'Continue' })
  await until(async () =>
    (await messages(client, project)).some(
      (message) => message.text === 'Recovered',
    ),
  )
})

test('human task input automatically steers the current run', async () => {
  let release!: () => void
  let entered = false
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const router = (req: FauxRequest) => {
    if (req.tools.includes('channel_start_topic'))
      return req.toolResults.length
        ? fauxText('Dispatched')
        : fauxToolCall('channel_start_topic', {
            title: 'Held task',
            brief: 'Wait for the decision',
          })
    return req.toolResults.length
      ? fauxText(
          req.lastUserText.includes('use blue')
            ? 'Applied blue in the same run'
            : 'Missing steer',
        )
      : fauxToolCall('hold_pause', {})
  }
  const { t, client } = await setup({
    responses: Array(20).fill(router),
    allowPendingResponses: true,
    extensions: [
      function hold(api) {
        api.registerTool({
          name: 'pause',
          description: 'Hold the task',
          inputSchema: z.object({}),
          execute: async () => {
            entered = true
            await held
            return 'released'
          },
        })
      },
    ],
  })
  const project = await client.request<Project>('/v1/projects', { cwd: t.cwd })
  const watch = await watchLocal(client, project.id)
  try {
    await client.request(`${sessionPath(project)}/messages`, {
      text: 'Start a task',
    })
    await until(() => entered)
    const sessions = (
      await client.request<{ sessions: Snapshot[] }>(
        `/v1/projects/${project.id}/sessions`,
      )
    ).sessions
    const task = sessions.find((session) => session.topic)!
    const runId = task.runId
    expect(runId).toBeTruthy()
    await client.request(`${sessionPath(project, task.sessionId)}/messages`, {
      text: 'use blue',
    })
    release()
    await until(async () =>
      (await messages(client, project, task.sessionId)).some(
        (message) => message.text === 'Applied blue in the same run',
      ),
    )
    await drainChannels(t.vela)
    const starts = watch.events.filter(
      (event) =>
        event.event === 'run_started' &&
        (event.data as { sessionId?: string }).sessionId === task.sessionId,
    )
    expect(starts).toHaveLength(1)
    expect((starts[0]!.data as { runId?: string }).runId).toBe(runId)
  } finally {
    release()
    await watch.close()
  }
})

test('Local provider failures keep actionable operator details in visible history and SSE', async () => {
  const { t, client } = await setup({
    responses: [
      fauxError(
        new APICallError({
          message: 'Invalid API key',
          statusCode: 401,
          url: 'https://example.invalid/chat',
          requestBodyValues: {},
        }),
      ),
    ],
    limits: { maxRetries: 0 },
  })
  const project = await client.request<Project>('/v1/projects', { cwd: t.cwd })
  const watch = await watchLocal(client, project.id)
  try {
    await client.request(`${sessionPath(project)}/messages`, { text: 'hello' })
    await drainChannels(t.vela)
    const history = await messages(client, project)
    expect(history).toContainEqual(
      expect.objectContaining({
        role: 'assistant',
        text: 'Task failed: Invalid API key\nCheck your API key: /login or vela setup.',
      }),
    )
    await until(() => watch.events.some((event) => event.event === 'error'))
    expect(
      watch.events.find((event) => event.event === 'error')?.data,
    ).toMatchObject({
      data: { code: 'run_failed', message: 'Task failed: Invalid API key' },
    })
  } finally {
    await watch.close()
  }
})

test('a retry ends with its backoff while the retried request is still running (#571)', async () => {
  const { t, client } = await setup({
    // A slow backoff, then a request that never answers: the two ends are far apart
    limits: { retryBaseMs: 400, retryMaxMs: 400 },
    responses: [
      fauxError('429 Too Many Requests - Rate limit exceeded'),
      fauxHang(),
    ],
    allowPendingResponses: true,
  })
  const project = await client.request<Project>('/v1/projects', { cwd: t.cwd })
  const watch = await watchLocal(client, project.id)
  try {
    await client.request(`${sessionPath(project)}/messages`, {
      text: 'retry me',
    })
    const stages = () =>
      watch.events
        .map((event) => event.data as LocalEventData)
        .filter((event) => event.type === 'progress')
        .map((event) => event.data as { stage: string; state?: string })
    await until(() =>
      stages().some(
        (stage) => stage.stage === 'retry' && stage.state === 'started',
      ),
    )
    await until(() =>
      stages().some(
        (stage) => stage.stage === 'retry' && stage.state === 'finished',
      ),
    )
    // The retried request is what runs now, and it has not answered: the label is already gone
    expect(stages()).toEqual([
      { stage: 'retry', state: 'started' },
      { stage: 'retry', state: 'finished' },
    ])
    expect(t.model.calls.length).toBeGreaterThanOrEqual(2)
    const session = (
      await client.request<{ sessions: Snapshot[] }>(
        `/v1/projects/${project.id}/sessions`,
      )
    ).sessions[0]!
    expect(session.state).toBe('running')
    await client.request(`${sessionPath(project)}/stop`, {
      runId: session.runId,
    })
  } finally {
    await watch.close()
    await drainChannels(t.vela)
  }
})

test('a backoff a Stop cut short never publishes into the next run (#571)', async () => {
  const { t, client } = await setup({
    // Long enough to stop inside it, then an answer for the run that follows
    limits: { retryBaseMs: 500, retryMaxMs: 500 },
    responses: [
      fauxError('429 Too Many Requests - Rate limit exceeded'),
      fauxText('Second run answered'),
    ],
  })
  const project = await client.request<Project>('/v1/projects', { cwd: t.cwd })
  const watch = await watchLocal(client, project.id)
  try {
    await client.request(`${sessionPath(project)}/messages`, {
      text: 'retry me',
    })
    const events = () =>
      watch.events.map((event) => event.data as LocalEventData)
    await until(() =>
      events().some(
        (event) =>
          event.type === 'progress' &&
          (event.data as { state?: string }).state === 'started',
      ),
    )
    const session = (
      await client.request<{ sessions: Snapshot[] }>(
        `/v1/projects/${project.id}/sessions`,
      )
    ).sessions[0]!
    await client.request(`${sessionPath(project)}/stop`, {
      runId: session.runId,
    })
    await until(() => events().some((event) => event.type === 'run_finished'))
    // A new run starts right away; the aborted backoff must not land inside it, or after its end
    await client.request(`${sessionPath(project)}/messages`, {
      text: 'ask again',
    })
    await until(() =>
      events().some(
        (event) =>
          event.type === 'message' &&
          (event.data as { text?: string }).text === 'Second run answered',
      ),
    )
    // Past the moment the abandoned backoff would have ended
    await Bun.sleep(700)
    const finishedAt = events().findIndex(
      (event) => event.type === 'run_finished',
    )
    expect(
      events()
        .slice(finishedAt + 1)
        .filter(
          (event) =>
            event.type === 'progress' &&
            (event.data as { stage?: string }).stage === 'retry',
        ),
    ).toEqual([])
  } finally {
    await watch.close()
    await drainChannels(t.vela)
  }
})

function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

test('Local SSE offers Stop during preparation and reports its queued successor without polling', async () => {
  const held = latch()
  const entered = latch()
  const { t, client } = await setup({
    ephemeralSessions: true,
    responses: [fauxText('Queued after preparation Stop')],
    allowPendingResponses: true,
  })
  const origSession = t.vela.session.bind(t.vela)
  Object.defineProperty(t.vela, 'session', {
    value: (id: string, opts?: Parameters<typeof origSession>[1]) => {
      const s = origSession(id, opts)
      if (id.startsWith('local-')) {
        const origResume = s.resume.bind(s)
        s.resume = async () => {
          entered.release()
          await held.promise
          return origResume()
        }
      }
      return s
    },
  })
  const project = await client.request<Project>('/v1/projects', { cwd: t.cwd })
  const watch = await watchLocal(client, project.id)
  try {
    await client.request(`${sessionPath(project)}/messages`, {
      text: 'Hold preparation',
    })
    await entered.promise
    await until(
      () => watch.events.some((event) => event.event === 'run_started'),
      'preparation run_started',
    )
    const first = watch.events.find((event) => event.event === 'run_started')!
      .data as { runId: string }
    expect(first.runId).toBeTruthy()
    expect(t.model.calls).toHaveLength(0)
    expect(
      watch.events.some(
        (event) =>
          event.event === 'session' &&
          (event.data as { data?: { runId?: string } }).data?.runId ===
            first.runId,
      ),
    ).toBe(true)
    await client.request(`${sessionPath(project)}/stop`, { runId: first.runId })
    await client.request(`${sessionPath(project)}/messages`, {
      text: 'Queue next',
    })
    held.release()
    await drainChannels(t.vela)
    await until(
      () =>
        watch.events.filter((event) => event.event === 'run_finished')
          .length === 2,
      'both lifecycle finishes',
    )
    const starts = watch.events
      .filter((event) => event.event === 'run_started')
      .map((event) => event.data as { runId: string })
    const finishes = watch.events
      .filter((event) => event.event === 'run_finished')
      .map(
        (event) => event.data as { runId: string; data: { outcome: string } },
      )
    expect(starts).toHaveLength(2)
    expect(starts[1]!.runId).not.toBe(first.runId)
    expect(finishes.map((event) => [event.runId, event.data.outcome])).toEqual([
      [first.runId, 'stopped'],
      [starts[1]!.runId, 'done'],
    ])
    expect(t.model.calls).toHaveLength(1)
    expect(await messages(client, project)).toContainEqual(
      expect.objectContaining({ text: 'Queued after preparation Stop' }),
    )
  } finally {
    held.release()
    await watch.close()
  }
})

test('Local SSE finishes a preparation failure before any model event', async () => {
  const { t, client } = await setup({
    ephemeralSessions: true,
  })
  const origSession = t.vela.session.bind(t.vela)
  Object.defineProperty(t.vela, 'session', {
    value: (id: string, opts?: Parameters<typeof origSession>[1]) => {
      const s = origSession(id, opts)
      if (id.startsWith('local-')) {
        s.resume = async () => {
          throw new Error('Project session storage unavailable')
        }
      }
      return s
    },
  })
  const project = await client.request<Project>('/v1/projects', { cwd: t.cwd })
  const watch = await watchLocal(client, project.id)
  try {
    await client.request(`${sessionPath(project)}/messages`, {
      text: 'Read project',
    })
    await drainChannels(t.vela)
    await until(
      () => watch.events.some((event) => event.event === 'run_finished'),
      'preparation failure lifecycle',
    )
    const started = watch.events.find((event) => event.event === 'run_started')!
      .data as { runId: string }
    expect(
      watch.events.find((event) => event.event === 'run_finished')?.data,
    ).toMatchObject({ runId: started.runId, data: { outcome: 'failed' } })
    expect(JSON.stringify(await messages(client, project))).toContain(
      'Project session storage unavailable',
    )
    expect(t.model.calls).toHaveLength(0)
  } finally {
    await watch.close()
  }
})
