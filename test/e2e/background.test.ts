import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { createVela } from '@glows777/vela'
import { createFauxModel, tempDir } from '@glows777/vela/testing'
import { local } from '@glows777/vela-channels'
import type { ExecutionEnv } from '@glows777/vela-core'
import { fauxText, fauxToolCall } from '@glows777/vela-core/testing'
import { lark } from '@glows777/vela-lark'
import z from 'zod'
import { createLocalExecutionEnv } from '../../packages/core/src/execution/local.ts'
import { background } from '../../packages/core/src/extensions/background/index.ts'
import { fakeLark, larkEvent } from '../support/lark.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

async function until(
  check: () => boolean | Promise<boolean>,
  what = 'condition',
) {
  const deadline = Date.now() + 5000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

const topicEvent = (message_id: string, text: string) =>
  larkEvent({
    message_id,
    root_id: 'root',
    thread_id: 'thread',
    content: JSON.stringify({ text }),
  })

test('a topic answers another message while a background command runs, then the exit arrives as a reply', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'sleep 0.5; echo READY',
        run_in_background: true,
      }),
      fauxText('Started the check.'),
      fauxText('Still running.'),
      (request) => {
        expect(request.lastUserText).toContain(
          'Background command bg-1 finished with exit code 0.',
        )
        expect(request.lastUserText).toContain('READY')
        return fauxText('The check finished.')
      },
    ],
    extensions: [
      background(),
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(topicEvent('trigger', 'run the slow check'))
  await until(() => fake.sent.length === 1, 'the first reply')
  // The command is still sleeping: answer a new message first.
  fake.deliver(topicEvent('status', 'what is the status?'))
  await until(() => fake.sent.length === 2, 'the status reply')
  await until(() => fake.sent.length === 3, 'the exit reply')
  expect(fake.sent).toEqual([
    {
      messageId: 'trigger',
      text: '<at user_id="ou_alice"></at> Started the check.',
    },
    {
      messageId: 'status',
      text: '<at user_id="ou_alice"></at> Still running.',
    },
    // The result is a new reply in the same topic, anchored to its root message.
    {
      messageId: 'root',
      text: '<at user_id="ou_alice"></at> The check finished.',
    },
  ])
  const last = t.model.calls.at(-1)!
  expect(last.lastUserText).toStartWith('Background command bg-1 finished')
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain(
    'Command running in background with ID: bg-1.',
  )
})

test('background_stop ends a topic job and background_output reports an id lost to !restart', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', { command: 'sleep 30', run_in_background: true }),
      fauxText('Started.'),
      fauxToolCall('background_stop', { id: 'bg-1' }),
      fauxText('Stopped it.'),
      fauxToolCall('background_output', { id: 'bg-1' }),
      fauxText('It is gone.'),
    ],
    extensions: [
      background(),
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(topicEvent('trigger', 'start a long server'))
  await until(() => fake.sent.length === 1, 'the start reply')
  fake.deliver(topicEvent('stop', 'stop it'))
  await until(() => fake.sent.length === 2, 'the stop reply')
  // background_stop returns the tail in its tool result; no separate delivery turn competes with it.
  const stopResult = t.model.calls
    .flatMap((call) => call.toolResults)
    .find((result) => result.toolName === 'background_stop')!.output
  expect(stopResult).toContain('bg-1 (stopped)')
  expect(fake.sent[1]!.text).toContain('Stopped it.')

  fake.deliver(topicEvent('restart', '!restart'))
  await until(() => fake.sent.length === 3, 'the restart notice')
  fake.deliver(topicEvent('check', 'check bg-1'))
  await until(() => fake.sent.length === 4, 'the reply after restart')
  expect(fake.sent[3]!.text).toContain('It is gone.')
  expect(t.model.calls.at(-1)!.toolResults[0]!.output).toContain(
    'Unknown background command bg-1. It may have finished and its result was delivered (or returned by background_stop), or it ended with a restart or session close.',
  )
})

test('a topic session stays open while a background command runs, past its idle deadline', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    channelIdleMs: 50,
    responses: [
      fauxToolCall('bash', {
        command: 'sleep 0.5; echo READY',
        run_in_background: true,
      }),
      fauxText('Started the check.'),
      fauxText('The check finished.'),
    ],
    extensions: [
      background(),
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(topicEvent('trigger', 'start the slow check'))
  await until(() => fake.sent.length === 1, 'the first reply')
  const topic = 'lark-oc_group-root'
  // Past the idle deadline the command is still running, so the session must stay open.
  await Bun.sleep(300)
  expect(t.vela.sessions().map((session) => session.id)).toContain(topic)
  await until(() => fake.sent.length === 2, 'the exit reply')
  expect(fake.sent[1]!.text).toContain('The check finished.')
  // With no command left, the same deadline closes it as usual.
  await until(
    () => !t.vela.sessions().some((session) => session.id === topic),
    'the idle close',
  )
})

test('a preopened topic session, closed idle and resumed, still queues its background results', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    channelIdleMs: 50,
    responses: [
      fauxToolCall('bash', { command: 'echo FIRST', run_in_background: true }),
      fauxText('Started the first check.'),
      fauxText('The first check finished.'),
      fauxToolCall('bash', { command: 'echo SECOND', run_in_background: true }),
      fauxText('Started the second check.'),
      fauxText('The second check finished.'),
    ],
    extensions: [
      background(),
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  const topic = 'lark-oc_group-root'
  // An SDK (or CLI) caller opens the topic session before any channel message exists.
  const preopened = t.vela.session(topic)
  await t.vela.startChannels()
  fake.deliver(topicEvent('trigger', 'run the first check'))
  await until(() => fake.sent.length === 1, 'the first start reply')
  // The gateway took over that same object rather than opening another one.
  expect(t.vela.sessions().find((session) => session.id === topic)).toBe(
    preopened,
  )
  await until(() => fake.sent.length === 2, 'the first exit reply')
  expect(fake.sent[1]).toEqual({
    messageId: 'root',
    text: '<at user_id="ou_alice"></at> The first check finished.',
  })
  // Idle cleanup saves and closes it; the next message reopens the same id and resumes that history.
  await until(
    () => !t.vela.sessions().some((session) => session.id === topic),
    'the idle close',
  )
  fake.deliver(topicEvent('again', 'run the second check'))
  await until(() => fake.sent.length === 3, 'the second start reply')
  await until(() => fake.sent.length === 4, 'the second exit reply')
  expect(fake.sent[2]).toEqual({
    messageId: 'again',
    text: '<at user_id="ou_alice"></at> Started the second check.',
  })
  // Resumed history, and the result still enters the queue anchored at the topic root.
  expect(fake.sent[3]).toEqual({
    messageId: 'root',
    text: '<at user_id="ou_alice"></at> The second check finished.',
  })
  expect(t.model.calls.at(-1)!.lastUserText).toStartWith(
    'Background command bg-1 finished with exit code 0.',
  )
})

test('a delivered job is forgotten, so background_output explains that it has ended', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', { command: 'echo DONE', run_in_background: true }),
      fauxText('Started the check.'),
      fauxText('The check finished.'),
      fauxToolCall('background_output', { id: 'bg-1' }),
      fauxText('It has ended.'),
    ],
    extensions: [
      background(),
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(topicEvent('trigger', 'run the check'))
  await until(() => fake.sent.length === 2, 'the exit reply')
  fake.deliver(topicEvent('check', 'check bg-1'))
  await until(() => fake.sent.length === 3, 'the check reply')
  expect(fake.sent[2]!.text).toContain('It has ended.')
  expect(t.model.calls.at(-1)!.toolResults[0]!.output).toContain(
    'Unknown background command bg-1. It may have finished and its result was delivered',
  )
})

test('background tools run in the group session and its topics, never in a DM', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    responses: [fauxText('group answer'), fauxText('dm answer')],
    extensions: [
      background(),
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(
    larkEvent({ message_id: 'group', content: '{"text":"@_user_1 hi"}' }),
  )
  await until(() => t.model.calls.length === 1, 'the group reply')
  expect(t.model.calls[0]!.tools).toEqual(
    expect.arrayContaining(['bash', 'background_output', 'background_stop']),
  )
  expect(t.model.calls[0]!.tools).not.toContain('background_start')

  fake.deliver(topicEvent('topic', 'do the work'))
  await until(() => t.model.calls.length === 2, 'the topic reply')
  expect(t.model.calls[1]!.tools).toEqual(
    expect.arrayContaining(['bash', 'background_output', 'background_stop']),
  )

  const dm = larkEvent(
    {
      chat_id: 'oc_dm',
      chat_type: 'p2p',
      message_id: 'dm',
      content: '{"text":"hi"}',
    },
    'ou_alice',
  )
  fake.deliver(dm)
  await until(() => t.model.calls.length === 3, 'the DM reply')
  for (const name of ['background_output', 'background_stop'])
    expect(t.model.calls[2]!.tools).not.toContain(name)
})

test('a session with bash but not the job tools is not told to use run_in_background', async () => {
  const t = createTestVela({
    responses: [fauxText('hello')],
    extensions: [background()],
    // A legitimate narrow configuration whose bash must refuse the parameter.
    session: { tools: ['bash'] },
  })
  await t.run('hi')
  const system = t.model.calls[0]!.system
  expect(system).not.toContain('run_in_background')
  // The parameter explains its own condition where the model sees it.
  const bash = t.session.registry.get('bash')!
  expect(bash.description).toContain('run_in_background')
})

test('an enabled session states the background condition on the parameter, not as a rule', async () => {
  const t = createTestVela({
    responses: [fauxText('hello')],
    extensions: [background()],
  })
  await t.run('hi')
  expect(t.model.calls[0]!.tools).toEqual(
    expect.arrayContaining(['bash', 'background_stop']),
  )
  // The condition travels with the parameter itself, which the model reads in the tool schema.
  const bash = t.session.registry.get('bash')!
  const schema = z.toJSONSchema(bash.inputSchema as z.ZodType) as {
    properties?: Record<string, { description?: string }>
  }
  expect(schema.properties?.run_in_background?.description).toContain(
    'Available only when this session has the background tools',
  )
  // No standing rule: the parameter is unusable in some legitimate tool lists.
  expect(bash.promptGuidelines ?? []).toEqual([])
  // The start result carries the id and the tail; the log path comes with the exit notification.
  expect(bash.description).not.toContain('output file')
})

test('a nested bash call cancelled while its job is being recorded starts nothing', async () => {
  // The calling tool's own signal: no agent_end cleanup covers this path.
  const controller = new AbortController()
  const gate = Promise.withResolvers<void>()
  let started = false
  let nested: unknown
  const results: string[] = []
  const t = createTestVela({
    responses: [fauxToolCall('probe', {}), fauxText('The probe gave up.')],
    extensions: [
      background(),
      function probe(vela) {
        vela.registerTool({
          name: 'probe',
          description: 'Starts a background command through another tool',
          inputSchema: z.object({}).strict(),
          execute: async (_input, context) => {
            nested = await context!.executeTool!(
              'bash',
              { command: 'touch marker; echo RAN', run_in_background: true },
              { signal: controller.signal },
            )
            return 'probed'
          },
        })
      },
    ],
    session: {
      tools: ['bash', 'background_stop', 'probe'],
      host: {
        deliver() {},
        async background(event) {
          if (event.type === 'result') results.push(event.text)
          if (event.type !== 'started') return
          started = true
          await gate.promise
        },
      },
    },
  })
  const running = t.run('probe it')
  await until(() => started, 'the admitted job')
  // Cancelled while the host is still recording the job; it must launch nothing.
  controller.abort()
  gate.resolve()
  await running
  expect(nested).toMatchObject({ isError: true })
  expect(nested).toMatchObject({ result: expect.stringContaining('aborted') })
  // Nothing ran, so nothing has an exit to announce.
  expect(results).toEqual([])
  expect(existsSync(t.path('marker'))).toBe(false)
})

test('a DM refuses run_in_background because it has no tool to read or stop the job', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'touch cannot-run; echo RAN',
        run_in_background: true,
      }),
      (request) => {
        expect(request.toolResults[0]!.output).toContain(
          'Background commands are not enabled in this session',
        )
        return fauxText('Background commands are not available here.')
      },
    ],
    extensions: [
      background(),
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(
    larkEvent(
      {
        chat_id: 'oc_dm',
        chat_type: 'p2p',
        message_id: 'dm',
        content: '{"text":"run the slow check"}',
      },
      'ou_alice',
    ),
  )
  await until(() => fake.sent.length === 1, 'the reply')
  // A DM keeps bash and loses the two job tools, so bash must not start a job it cannot end.
  expect(t.model.calls[0]!.tools).toContain('bash')
  expect(t.model.calls[0]!.tools).not.toContain('background_stop')
  expect(existsSync(t.path('cannot-run'))).toBe(false)
})

test('a narrowed chat list drops the background tools the group session gets by default', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    responses: [fauxText('hello')],
    extensions: [
      background(),
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: [{ id: 'oc_group', tools: ['read_file'] }],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(
    larkEvent({ message_id: 'group', content: '{"text":"@_user_1 hi"}' }),
  )
  await until(() => t.model.calls.length === 1, 'the group reply')
  for (const name of ['background_output', 'background_stop', 'bash'])
    expect(t.model.calls[0]!.tools).not.toContain(name)
  expect(t.model.calls[0]!.tools).toContain('read_file')
})

test('a group hub runs a background command and answers its exit in the main timeline', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'sleep 0.5; echo READY',
        run_in_background: true,
      }),
      fauxText('Started the check.'),
      fauxText('Still running.'),
      (request) => {
        expect(request.lastUserText).toStartWith(
          'Background command bg-1 finished with exit code 0.',
        )
        expect(request.lastUserText).toContain('READY')
        return fauxText('The check finished.')
      },
    ],
    extensions: [
      background(),
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(
    larkEvent({
      message_id: 'trigger',
      content: '{"text":"@_user_1 check slowly"}',
    }),
  )
  await until(() => fake.sent.length === 1, 'the first reply')
  // The command is still sleeping: the hub answers a new message instead of blocking on it.
  fake.deliver(
    larkEvent({ message_id: 'status', content: '{"text":"@_user_1 status?"}' }),
  )
  await until(() => fake.sent.length === 2, 'the status reply')
  await until(() => fake.sent.length === 3, 'the exit reply')
  expect(fake.sent).toEqual([
    { messageId: 'trigger', text: 'Started the check.' },
    { messageId: 'status', text: 'Still running.' },
    // The exit joined the hub's own queue, so it replies in the main timeline like any input.
    { messageId: 'status', text: 'The check finished.' },
  ])
  expect(t.model.calls.at(-1)!.tools).toContain('bash')
})

test('a Local project hub runs bash and a background exit arrives as the next hub input', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', { command: 'echo HUB_BASH' }),
      fauxText('The shell printed HUB_BASH.'),
      fauxToolCall('bash', {
        command: 'sleep 0.3; echo READY',
        run_in_background: true,
      }),
      fauxText('Started the check.'),
      (request) => {
        expect(request.lastUserText).toStartWith(
          'Background command bg-1 finished with exit code 0.',
        )
        expect(request.lastUserText).toContain('READY')
        return fauxText('The check finished.')
      },
    ],
    extensions: [background(), local({})],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  const host = t.vela.channel('local')
  const project = await host.openProject({ cwd: t.cwd, name: 'Hub' })
  const visible = async (text: string) =>
    (
      await host.messages({
        projectId: project.id,
        sessionId: project.sessionId,
      })
    ).messages.some((message) => message.text === text)

  await host.submit({
    projectId: project.id,
    sessionId: project.sessionId,
    text: 'Check the shell',
  })
  await until(
    async () => visible('The shell printed HUB_BASH.'),
    'the bash reply',
  )
  // The hub ran the command itself: no dispatch, and the model saw its output.
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain('HUB_BASH')
  expect(t.model.calls[0]!.tools).toContain('bash')

  await host.submit({
    projectId: project.id,
    sessionId: project.sessionId,
    text: 'Check slowly',
  })
  await until(async () => visible('Started the check.'), 'the start reply')
  await until(async () => visible('The check finished.'), 'the exit reply')
  expect(t.model.calls.at(-1)!.lastUserText).toStartWith(
    'Background command bg-1 finished',
  )
})

test('bash run_in_background returns at once with its id, then the exit starts its own turn', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'sleep 0.5; echo READY > ready.txt; echo READY',
        run_in_background: true,
      }),
      () => {
        // The tool result arrived while the command still sleeps, so the turn continued.
        expect(existsSync(t.path('ready.txt'))).toBe(false)
        return fauxText('Started the slow check.')
      },
      fauxText('The check finished.'),
    ],
    extensions: [background()],
  })
  await t.run('start the slow check')
  await until(() => t.model.calls.length === 3, 'the exit turn')
  await until(() => !t.session.isRunning, 'the delivery run to settle')
  const started = t.model.calls[1]!.toolResults[0]!.output
  expect(started).toContain('Command running in background with ID: bg-1.')
  expect(started).toContain(
    'You will be notified when it completes; do not poll the file or start a second copy.',
  )
  // The delivery starts its own turn with the exit state and the tail.
  const delivery = t.model.calls[2]!.lastUserText
  expect(delivery).toStartWith(
    'Background command bg-1 finished with exit code 0.',
  )
  expect(delivery).toContain('READY')
  expect(
    await Bun.file(t.session.registry.results.history.path).text(),
  ).toContain('"backgroundTaskId":"bg-1"')
})

test('a long background command spills in the session environment, and read_file pages it', async () => {
  let log = ''
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', { command: 'seq 1 20000', run_in_background: true }),
      () => fauxText('Started it.'),
      fauxText('It finished.'),
      () => fauxToolCall('read_file', { path: log, offset: 1, limit: 3 }),
      (request) => {
        expect(request.toolResults[0]!.output).toStartWith('1\n2\n3\n')
        return fauxToolCall('read_file', { path: log, offset: 20000, limit: 3 })
      },
      (request) => {
        expect(request.toolResults[0]!.output).toBe('20000\n')
        return fauxText('Read the whole log.')
      },
    ],
    extensions: [background()],
  })
  await t.run('start the noisy command')
  await until(() => t.model.calls.length === 3, 'the exit turn')
  await until(() => !t.session.isRunning, 'the delivery run to settle')
  // The start reports the id and the tail it has; it never points at a log that is still empty.
  const started = t.model.calls[1]!.toolResults[0]!.output
  expect(started).toContain('Command running in background with ID: bg-1.')
  expect(started).not.toContain('Full output')
  // The tail the model reads is bounded to the last 2,000 lines; the exit delivery names the file.
  const delivery = t.model.calls[2]!.lastUserText
  expect(delivery).toContain('\n18001\n')
  expect(delivery).not.toContain('\n1\n')
  log = /Full output: (\S+)/.exec(delivery)![1]!
  // The file is the environment's own spill file, inside the session, so read_file pages all of it.
  expect(log).toStartWith(t.session.registry.results.dir)
  expect(await Bun.file(log).text()).toEndWith('20000\n')
  expect((await Bun.file(log).text()).split('\n').length).toBe(20001)
  await t.run('read the log')
  expect(t.model.calls.length).toBe(6)
})

test('an adapter that only implements the published contract gets its own log named on exit', async () => {
  const dir = tempDir()
  // A host adapter written against today's `ExecutionEnv`: it forwards `onOutput` and keeps its own
  // spill file, which it can name only once the command has finished.
  const hostEnv = (cwd: string): ExecutionEnv => {
    const base = createLocalExecutionEnv({ cwd })
    const adapter: ExecutionEnv = Object.create(base)
    adapter.exec = async (command, options, signal) => {
      let collected = ''
      const result = await base.exec(
        command,
        {
          ...options,
          spill: undefined,
          onOutput: (chunk, chunkSignal, info) => {
            collected += chunk
            options?.onOutput?.(chunk, chunkSignal, info)
          },
        },
        signal,
      )
      const full = await base.createTempFile(
        { prefix: 'adapter-', suffix: '.log' },
        signal,
      )
      if (!result.ok || !full.ok) return result
      await base.writeFile(full.value, collected, signal)
      return { ok: true, value: { ...result.value, spillPath: full.value } }
    }
    return adapter
  }
  let log = ''
  const model = createFauxModel({
    responses: [
      fauxToolCall('bash', { command: 'seq 1 20000', run_in_background: true }),
      fauxText('Started it.'),
      fauxText('The command finished.'),
      () => fauxToolCall('read_file', { path: log, offset: 1, limit: 2 }),
      (request) => {
        expect(request.toolResults[0]!.output).toStartWith('1\n2\n')
        return fauxText('Read the adapter log.')
      },
    ],
  })
  const vela = createVela({
    cwd: dir.path,
    dataDir: '.data',
    model,
    extensions: [background()],
    env: ({ location }) => hostEnv(location.cwd),
  })
  try {
    const session = vela.session('adapter')
    await session.prompt('start the noisy command')
    await until(() => model.calls.length === 3, 'the exit turn')
    // The start names the job and its tail, never a file that is still empty.
    const started = model.calls[1]!.toolResults[0]!.output
    expect(started).toContain('Command running in background with ID: bg-1.')
    expect(started).not.toContain('Full output')
    // The exit notification names the file the adapter spilled to, not one the session created.
    const delivery = model.calls[2]!.lastUserText
    expect(delivery).toContain('Background command bg-1 finished')
    log = /Full output: (\S+)/.exec(delivery)?.[1] ?? ''
    expect(log).toContain('adapter-')
    expect((await Bun.file(log).text()).trimEnd().split('\n')).toHaveLength(
      20000,
    )
    // The exit started its own turn; wait for it to settle before prompting again.
    await until(() => !session.isRunning, 'the delivery run to settle')
    await session.prompt('read the adapter log')
    expect(model.calls.at(-1)!.toolResults[0]!.output).toStartWith('1\n2\n')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('a background command with no output says so and names no file', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', { command: 'true', run_in_background: true }),
      fauxText('Started the quiet check.'),
      (request) => {
        expect(request.lastUserText).toContain('Output:\n(no output)')
        // Nothing spilled, so there is no log to point at.
        expect(request.lastUserText).not.toContain('Full output')
        return fauxText('The quiet check finished.')
      },
    ],
    extensions: [background()],
  })
  await t.run('start the quiet check')
  await until(() => t.model.calls.length === 3, 'the exit turn')
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain(
    'Command running in background with ID: bg-1.',
  )
})

test('without the background extension bash refuses run_in_background and starts nothing', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'touch marker; echo RAN',
        run_in_background: true,
      }),
      (request) => {
        expect(request.toolResults[0]!.output).toContain(
          'Background commands are not enabled in this session',
        )
        return fauxText('It is not enabled.')
      },
    ],
  })
  await t.run('start it in the background')
  expect(existsSync(t.path('marker'))).toBe(false)
})

test('/tasks lists a running job, /tasks stop ends it with its tail, and the footer status follows', async () => {
  const notices: string[] = []
  const statuses: (string | undefined)[] = []
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'echo READY; sleep 30',
        run_in_background: true,
      }),
      fauxText('Started the check.'),
    ],
    extensions: [background()],
    session: {
      ui: {
        notify: (message) => notices.push(message),
        confirm: async () => false,
        select: async () => undefined,
        input: async () => undefined,
        setStatus: (key, text) => {
          if (key === 'background') statuses.push(text)
        },
      },
    },
  })
  await t.run('start a slow check in the background')
  expect(statuses).toEqual(['1 background task · bg-1'])
  // The call returns at admission; the list shows the tail once the command writes it.
  await until(async () => {
    await t.run('/tasks')
    return notices.at(-1)!.includes('\n  READY')
  }, 'the job to write its output')
  expect(notices.at(-1)).toMatch(
    /^\[tasks\] 1 background task\nbg-1 · running · \d+s · \$ echo READY; sleep 30\n {2}READY$/,
  )
  await t.run('/tasks stop bg-1')
  expect(notices.at(-1)).toMatch(
    /^bg-1 · stopped · \d+s · \$ echo READY; sleep 30\n {2}READY$/,
  )
  expect(statuses.at(-1)).toBeUndefined()
  await t.run('/tasks')
  expect(notices.at(-1)).toBe('No background tasks')
  await t.run('/tasks stop bg-1')
  expect(notices.at(-1)).toContain('Unknown background command bg-1.')
  expect(notices.at(-1)).toContain(
    'It may have finished and its result was delivered (or returned by background_stop), or it ended with a restart or session close.',
  )
})
