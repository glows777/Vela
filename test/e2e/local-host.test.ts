import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdirSync, symlinkSync } from 'node:fs'
import { Server } from 'node:net'
import { join } from 'node:path'
import {
  type ChannelRuntime,
  type LocalEvent,
  type LocalHost,
  local,
} from '@glows777/vela-channels'
import { drainChannels } from '@glows777/vela-channels/testing'
import { inspectSession } from '@glows777/vela-core/diagnostics'
import {
  type FauxRequest,
  fauxHang,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'
import { lark } from '@glows777/vela-lark'
import { background } from '../../packages/core/src/extensions/background/index.ts'
import { fakeLark, larkEvent } from '../support/lark.ts'
import {
  freeLocalPort,
  LOCAL_TOKEN,
  LocalClient,
  sessionPath,
  until,
  watchLocal,
} from '../support/local.ts'
import { RoutineClock } from '../support/routine-clock.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

test('core-only Local exposes typed detached project views without listening and guards its lifecycle', async () => {
  const t = createTestVela({ extensions: [local({ port: 0 })] })
  await t.vela.ready()
  const host: LocalHost = t.vela.channel('local')
  const events: LocalEvent[] = []
  const off = host.onEvent((event) => events.push(event))
  await expect(host.openProject({ cwd: t.cwd })).rejects.toThrow('not running')
  const listen = spyOn(Server.prototype, 'listen')
  try {
    await t.vela.startChannels()
    expect(listen).not.toHaveBeenCalled()
  } finally {
    listen.mockRestore()
  }
  expect(host.connection()).toEqual({ connected: true })
  const project = await host.openProject({ cwd: t.cwd, name: 'Project' })
  const alias = join(t.cwd, 'alias')
  symlinkSync(t.cwd, alias, 'dir')
  expect((await host.openProject({ cwd: alias })).id).toBe(project.id)
  expect(host.projects()).toHaveLength(1)
  project.name = 'mutated'
  const projects = host.projects()
  projects[0]!.name = 'mutated again'
  expect(host.projects()[0]!.name).toBe('Project')
  const count = t.vela.sessions().length
  const sessions = host.sessions(project.id)
  expect(sessions).toHaveLength(1)
  expect(sessions[0]).toMatchObject({
    channel: 'local',
    sessionId: project.sessionId,
    state: 'done',
  })
  sessions[0]!.requester.name = 'mutated'
  expect(host.sessions(project.id)[0]!.requester.name).toBe('You')
  expect(t.vela.sessions()).toHaveLength(count)
  expect(events.some((event) => event.type === 'reset')).toBe(false)
  await t.vela.dispose()
  expect(host.connection()).toEqual({ connected: false })
  await expect(host.openProject({ cwd: t.cwd })).rejects.toThrow('not running')
  await expect(
    host.submit({
      projectId: project.id,
      sessionId: project.sessionId,
      text: 'late',
    }),
  ).rejects.toThrow('not running')
  off()
})

test('visible submissions validate addresses and history cursors and correlate rather than deduplicate client IDs', async () => {
  const t = createTestVela({
    responses: [fauxText('one'), fauxText('two')],
    extensions: [local({ port: 0 })],
  })
  await t.vela.startChannels()
  const host: LocalHost = t.vela.channel('local')
  const project = await host.openProject({ cwd: t.cwd })
  const address = { projectId: project.id, sessionId: project.sessionId }
  for (const body of [
    { ...address, text: '' },
    { ...address, text: '   ' },
    { ...address, text: 'x', clientMessageId: '' },
    { ...address, text: 'x', projectId: 'missing' },
    { ...address, text: 'x', sessionId: 'missing' },
  ])
    await expect(host.submit(body)).rejects.toThrow()
  await expect(
    host.openProject({ cwd: join(t.cwd, 'missing') }),
  ).rejects.toThrow()
  expect(() => host.messages({ ...address, after: 'unknown' })).toThrow()
  for (const limit of [0, 101, 1.5])
    expect(() => host.messages({ ...address, limit })).toThrow()
  expect(t.model.calls).toHaveLength(0)
  const first = await host.submit({
    ...address,
    text: 'same',
    clientMessageId: 'correlation',
  })
  await drainChannels(t.vela)
  const second = await host.submit({
    ...address,
    text: 'same',
    clientMessageId: 'correlation',
  })
  await drainChannels(t.vela)
  expect(second.messageId).not.toBe(first.messageId)
  const all = host.messages(address).messages
  expect(
    all.filter((message) => message.clientMessageId === 'correlation'),
  ).toHaveLength(2)
  const page = host.messages({ ...address, limit: 1 })
  expect(page.messages).toHaveLength(1)
  expect(page.nextCursor).toBe(page.messages[0]!.id)
  expect(
    host.messages({ ...address, after: page.nextCursor }).messages,
  ).toEqual(all.slice(1))
  page.messages[0]!.text = 'mutated'
  expect(host.messages(address).messages[0]!.text).toBe('same')
})

test('visible input is persisted before runtime admission and failed admission rolls it back without publishing it', async () => {
  let runtime!: ChannelRuntime
  const t = createTestVela({
    extensions: [
      (api) =>
        local({ port: 0 })({
          ...api,
          registerChannel(channel) {
            const connect = channel.connect!.bind(channel)
            channel.connect = (value) => {
              runtime = value
              connect(value)
            }
            api.registerChannel(channel)
          },
        }),
    ],
  })
  await t.vela.startChannels()
  const host: LocalHost = t.vela.channel('local')
  const project = await host.openProject({ cwd: t.cwd })
  const address = { projectId: project.id, sessionId: project.sessionId }
  const events: LocalEvent[] = []
  host.onEvent((event) => events.push(event))
  const submit = spyOn(runtime, 'submit').mockImplementation(async () => {
    expect(host.messages(address).messages).toMatchObject([
      { role: 'user', text: 'rejected' },
    ])
    throw new Error('admission rejected')
  })
  try {
    await expect(host.submit({ ...address, text: 'rejected' })).rejects.toThrow(
      'admission rejected',
    )
    expect(submit).toHaveBeenCalledTimes(1)
    expect(host.messages(address).messages).toEqual([])
    expect(events.filter((event) => event.type === 'message')).toEqual([])
    expect(t.model.calls).toHaveLength(0)
  } finally {
    submit.mockRestore()
  }
})

test('SDK and HTTP share projects, visible history and event envelopes while SSE reset and disconnect stay transport-only', async () => {
  const port = await freeLocalPort()
  const t = createTestVela({
    responses: [
      fauxText('SDK answer'),
      fauxText('HTTP answer'),
      fauxText('after disconnect'),
    ],
    extensions: [local({ token: LOCAL_TOKEN, port })],
  })
  await t.vela.startChannels()
  const host: LocalHost = t.vela.channel('local')
  const client = new LocalClient(`http://127.0.0.1:${port}`, LOCAL_TOKEN)
  const project = await host.openProject({ cwd: t.cwd })
  const events: LocalEvent[] = []
  host.onEvent((event) => events.push(event), { projectId: project.id })
  const watch = await watchLocal(client, project.id)
  try {
    expect(watch.events[0]!.event).toBe('reset')
    expect(events).toEqual([])
    expect(
      await client.request<{ projects: ReturnType<typeof host.projects> }>(
        '/v1/projects',
      ),
    ).toEqual({
      projects: host.projects(),
    })
    await host.submit({
      projectId: project.id,
      sessionId: project.sessionId,
      text: 'SDK input',
    })
    await drainChannels(t.vela)
    await client.request(`${sessionPath(project)}/messages`, {
      text: 'HTTP input',
    })
    await drainChannels(t.vela)
    const address = { projectId: project.id, sessionId: project.sessionId }
    expect(
      await client.request<ReturnType<typeof host.messages>>(
        `${sessionPath(project)}/messages`,
      ),
    ).toEqual(host.messages(address))
    await until(
      () =>
        watch.events.filter((event) => event.event !== 'reset').length ===
        events.length,
    )
    expect(
      watch.events
        .filter((event) => event.event !== 'reset')
        .map((event) => event.data),
    ).toEqual(events)
    expect(
      events.every(
        (event) => event.version === 1 && !!event.id && !!event.time,
      ),
    ).toBe(true)
  } finally {
    await watch.close()
  }
  const before = events.length
  await host.submit({
    projectId: project.id,
    sessionId: project.sessionId,
    text: 'still connected',
  })
  await drainChannels(t.vela)
  expect(events.length).toBeGreaterThan(before)
  expect(events.some((event) => event.type === 'reset')).toBe(false)
  expect(host.connection()).toEqual({ connected: true })
})

function taskRouter(request: FauxRequest) {
  if (request.tools.includes('channel_start_topic'))
    return request.toolResults.length
      ? fauxText('Dispatched')
      : fauxToolCall('channel_start_topic', {
          title: 'Write result',
          brief: 'Write result.txt',
        })
  return request.toolResults.length
    ? fauxText('File ready')
    : fauxToolCall('write_file', {
        path: 'result.txt',
        content: 'local host file',
      })
}

test('core-only public Local submit triages a real task and writes in the opened project cwd', async () => {
  const t = createTestVela({
    responses: Array(20).fill(taskRouter),
    allowPendingResponses: true,
    extensions: [local({ port: 0 })],
  })
  await t.vela.startChannels()
  const host: LocalHost = t.vela.channel('local')
  const cwd = join(t.cwd, 'project')
  mkdirSync(cwd)
  const project = await host.openProject({ cwd })
  const events: LocalEvent[] = []
  host.onEvent((event) => events.push(event), { projectId: project.id })
  await host.submit({
    projectId: project.id,
    sessionId: project.sessionId,
    text: 'Write result.txt',
  })
  await drainChannels(t.vela)
  await until(() =>
    host
      .sessions(project.id)
      .some((session) => !!session.topic && session.state === 'done'),
  )
  expect(await Bun.file(join(cwd, 'result.txt')).text()).toBe('local host file')
  expect(await Bun.file(join(t.cwd, 'result.txt')).exists()).toBe(false)
  expect(events.some((event) => event.type === 'run_started')).toBe(true)
  expect(events.some((event) => event.type === 'run_finished')).toBe(true)
})

test('a project hub gets the group tool split, including in a session the host opened first', async () => {
  const t = createTestVela({
    responses: [
      fauxText('hub answer'),
      fauxText('second hub answer'),
      fauxText('third hub answer'),
      fauxText('fourth hub answer'),
      fauxText('fifth hub answer'),
    ],
    extensions: [background(), local({ port: 0 })],
  })
  await t.vela.startChannels()
  const host: LocalHost = t.vela.channel('local')

  const cwd = join(t.cwd, 'project')
  mkdirSync(cwd)
  const opened = await host.openProject({ cwd })
  await host.submit({
    projectId: opened.id,
    sessionId: opened.sessionId,
    text: 'Hello project',
  })
  await drainChannels(t.vela)
  const hub = t.vela.session(opened.sessionId)
  // A hub runs quick work itself (#421) but never waits for a decision: that is a topic control.
  expect(hub.getActiveTools()).toEqual(
    expect.arrayContaining([
      'bash',
      'write_file',
      'edit_file',
      'channel_start_topic',
    ]),
  )
  expect(hub.getActiveTools()).not.toContain('channel_wait_for_input')
  const prompt = (await inspectSession(t.vela, hub)).systemPrompt
  expect(prompt).toContain('- bash:')
  expect(prompt).not.toContain('- channel_wait_for_input:')

  // A host can open the chat's session before its first message (SDK `vela.session(id)`), which
  // constructs it without the channel's options. The channel's next message must still apply them.
  const other = join(t.cwd, 'second')
  mkdirSync(other)
  const later = await host.openProject({ cwd: other })
  const early = t.vela.session(later.sessionId)
  // A bare session has none of the hub's channel tools yet. The background tools come from the
  // background extension's default set, so they are already there.
  expect(early.getActiveTools()).not.toContain('channel_start_topic')
  expect(early.getActiveTools()).toContain('background_output')
  await host.submit({
    projectId: later.id,
    sessionId: later.sessionId,
    text: 'Hello again',
  })
  await drainChannels(t.vela)
  expect(t.vela.session(later.sessionId)).toBe(early)
  expect(early.getActiveTools().sort()).toEqual(hub.getActiveTools().sort())

  // The channel narrows a host's own allowlist, never widens it.
  const allowlists: { tools: string[]; expected: string[] }[] = [
    { tools: ['read_file'], expected: ['read_file'] },
    {
      tools: ['read_file', 'channel_wait_for_input'],
      expected: ['read_file'],
    },
    { tools: ['read_file', 'bash'], expected: ['read_file', 'bash'] },
  ]
  for (const [index, { tools, expected }] of allowlists.entries()) {
    const dir = join(t.cwd, `selected-${index}`)
    mkdirSync(dir)
    const selected = await host.openProject({ cwd: dir })
    const own = t.vela.session(selected.sessionId, { tools })
    await host.submit({
      projectId: selected.id,
      sessionId: selected.sessionId,
      text: `Selected ${index}`,
    })
    await drainChannels(t.vela)
    expect(own.getActiveTools()).toEqual(expected)
  }
})

test('real Lark and core-only Local share host controls but isolate snapshots, queued runs, routines and restart data', async () => {
  const fake = fakeLark()
  const extensions = [
    lark({
      owners: ['ou_alice'],
      chats: ['oc_group'],
      transport: fake.transport,
    }),
    local({ port: 0 }),
  ]
  const t = createTestVela({
    responses: [
      fauxToolCall('channel_wait_for_input', { reason: 'Choose' }),
      fauxText('Which?'),
      fauxHang(),
      fauxHang(),
      fauxHang(),
      fauxText('Local done'),
    ],
    extensions,
  })
  t.internals.gateway.routines.clock = new RoutineClock()
  await t.vela.startChannels()
  const host = t.vela.channel('lark')
  const localHost: LocalHost = t.vela.channel('local')
  fake.deliver(
    larkEvent({ message_id: 'root', root_id: 'root', thread_id: 'thread' }),
  )
  await drainChannels(t.vela)
  expect(host.sessions()[0]!.state).toBe('waiting')
  const input = {
    channelId: 'oc_group',
    senderId: 'ou_alice',
    senderName: 'Alice',
    text: 'Continue',
    replyToId: 'anchor',
    topic: { rootId: 'root', threadId: 'thread' },
  }
  await host.submit(input)
  await until(() => t.model.calls.length === 3)
  const first = host.sessions()[0]!.runId!
  await host.submit({ ...input, topic: undefined, text: 'queued hub' })
  // The hub has its own independent run; exact Stop never crosses a topic boundary.
  await until(() => t.model.calls.length === 4)
  const hub = host.sessions().find((session) => !session.topic)!
  expect(await host.stop({ chatId: 'oc_group', rootId: 'root' }, 'stale')).toBe(
    false,
  )
  expect(await host.stop({ chatId: 'oc_group', rootId: 'root' }, first)).toBe(
    true,
  )
  await host.submit({
    ...input,
    topic: undefined,
    text: 'later queued work',
    replyToId: 'later-anchor',
  })
  expect(t.model.calls).toHaveLength(4)
  expect(await host.stop({ chatId: 'oc_group' }, hub.runId!)).toBe(true)
  await until(() => t.model.calls.length === 5)
  const later = host.sessions().find((session) => !session.topic)!
  expect(later.runId).not.toBe(hub.runId)
  expect(t.model.calls[4]!.lastUserText).toContain('later queued work')
  expect(await host.stop({ chatId: 'oc_group' }, hub.runId!)).toBe(false)
  expect(await host.stop({ chatId: 'oc_group' }, later.runId!)).toBe(true)
  await drainChannels(t.vela)
  const project = await localHost.openProject({ cwd: t.cwd })
  await localHost.submit({
    projectId: project.id,
    sessionId: project.sessionId,
    text: 'Local',
  })
  await drainChannels(t.vela)
  expect(
    localHost.sessions().every((session) => session.chatId === project.id),
  ).toBe(true)
  expect(
    host.sessions().every((session) => session.chatId === 'oc_group'),
  ).toBe(true)
  const routine = await host.routines.create(
    { chatId: 'oc_group', rootId: 'root' },
    {
      message: 'Later',
      schedule: { at: '2026-01-05T09:00' },
      creator: { id: 'owner', name: 'Owner' },
    },
  )
  expect(localHost.routines.list({ chatId: project.id }).routines).toEqual([])
  const before = localHost.messages({
    projectId: project.id,
    sessionId: project.sessionId,
  })
  await t.cleanup({ keepDir: true })
  const again = createTestVela({ cwd: t.cwd, extensions })
  again.internals.gateway.routines.clock = new RoutineClock()
  await again.vela.startChannels()
  expect(again.vela.channel('local').projects()).toEqual([project])
  expect(
    again.vela
      .channel('local')
      .messages({ projectId: project.id, sessionId: project.sessionId }),
  ).toEqual(before)
  expect(
    again.vela
      .channel('lark')
      .routines.list({ chatId: 'oc_group' })
      .routines.map((item) => item.id),
  ).toContain(routine.id)
})
