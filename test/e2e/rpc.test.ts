import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { PhotonImage } from '@silvia-odwyer/photon-node'
import { tempDir } from '../support/vela.ts'

// `vela --mode rpc` child process: write JSONL commands to stdin, read responses / events / extension_ui_request from stdout

const ROOT = resolve(import.meta.dir, '../..')
const ENTRY = join(ROOT, 'packages/vela/src/cli/main.ts')
const scenario = (name: string) =>
  join(ROOT, 'test/fixtures/scenarios', `${name}.json`)

setDefaultTimeout(30_000)

const dirs: { cleanup(): void }[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

type RpcRecord = { type: string; [key: string]: unknown }

function startRpc(
  model: string,
  args: string[] = [],
  files: Record<string, string> = {},
  roots = { cwd: tempDir('vela-rpc-'), home: tempDir('vela-home-') },
) {
  const { cwd, home } = roots
  dirs.push(cwd, home)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(home.path, path)), { recursive: true })
    writeFileSync(join(home.path, path), content)
  }
  const proc = Bun.spawn(['bun', ENTRY, '--mode', 'rpc', ...args], {
    cwd: cwd.path,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home.path,
      VELA_DIR: home.path,
      VELA_MODEL: model,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const records: RpcRecord[] = []
  let waiters: (() => void)[] = []
  void (async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        records.push(JSON.parse(buffer.slice(0, newline)))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
      for (const wake of waiters.splice(0)) wake()
    }
    for (const wake of waiters.splice(0)) wake()
  })()
  const waitFor = async (
    match: (r: RpcRecord) => boolean,
  ): Promise<RpcRecord> => {
    for (;;) {
      const found = records.find(match)
      if (found) return found
      if (proc.exitCode !== null)
        throw new Error(
          `vela exited:\n${await new Response(proc.stderr).text()}`,
        )
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
  }
  let next = 0
  return {
    records,
    waitFor,
    send(command: Record<string, unknown>) {
      proc.stdin.write(`${JSON.stringify(command)}\n`)
      proc.stdin.flush()
    },
    /** Send a command and wait for its response */
    async call(command: Record<string, unknown>) {
      const id = `req-${++next}`
      this.send({ id, ...command })
      return waitFor((r) => r.type === 'response' && r.id === id)
    },
    async close() {
      proc.stdin.end()
      waiters = []
      return proc.exited
    },
  }
}

test.concurrent('rpc: prompt is accepted, events stream with the session id, state and messages are queryable', async () => {
  const rpc = startRpc(`faux:${scenario('hello')}`)

  expect(await rpc.call({ type: 'prompt', message: 'Hello' })).toMatchObject({
    command: 'prompt',
    success: true,
    data: { disposition: 'started' },
  })
  const settled = await rpc.waitFor((r) => r.type === 'agent_settled')
  const sessionId = settled.sessionId as string
  expect(rpc.records.find((r) => r.type === 'message_update')).toMatchObject({
    sessionId,
    assistantMessageEvent: { type: 'text_start' },
  })

  const state = await rpc.call({ type: 'get_state' })
  expect(state.data).toMatchObject({
    sessionId,
    isStreaming: false,
    thinkingLevel: 'medium',
    messageCount: 2,
    pendingMessageCount: 0,
    steeringMode: 'one-at-a-time',
  })
  expect(
    await rpc.call({ type: 'set_session_name', name: 'Test' }),
  ).toMatchObject({ success: true })
  const list = await rpc.call({ type: 'list_sessions' })
  expect((list.data as { sessions: unknown[] }).sessions).toEqual([
    expect.objectContaining({ id: sessionId, name: 'Test', messageCount: 2 }),
  ])
  const messages = await rpc.call({ type: 'get_messages' })
  expect((messages.data as { messages: unknown[] }).messages).toHaveLength(2)

  // Parse errors, unknown commands, bad arguments: success false, the process keeps going
  rpc.send({ nope: true } as Record<string, unknown>)
  expect(await rpc.waitFor((r) => r.command === 'parse')).toMatchObject({
    success: false,
  })
  expect(await rpc.call({ type: 'wat' })).toMatchObject({
    success: false,
    error: 'Unknown command: wat',
  })
  expect(
    await rpc.call({ type: 'set_steering_mode', mode: 'some' }),
  ).toMatchObject({ success: false })

  // New session: later events carry the new id
  const created = await rpc.call({ type: 'new_session' })
  expect((created.data as { sessionId: string }).sessionId).not.toBe(sessionId)
  expect(await rpc.call({ type: 'switch_session', sessionId })).toMatchObject({
    success: true,
  })
  expect((await rpc.call({ type: 'get_state' })).data).toMatchObject({
    sessionId,
    messageCount: 2,
    sessionName: 'Test',
  })

  expect(await rpc.close()).toBe(0)
})

test.concurrent('rpc: while running, prompt needs a streamingBehavior; queued messages can be cleared and abort waits', async () => {
  const rpc = startRpc(`faux:${scenario('hang')}`)

  await rpc.call({ type: 'prompt', message: 'Think slowly' })
  await rpc.waitFor((r) => r.type === 'message_update')

  expect(
    await rpc.call({ type: 'prompt', message: 'Interject' }),
  ).toMatchObject({
    success: false,
  })
  expect(
    await rpc.call({
      type: 'prompt',
      message: 'Later',
      streamingBehavior: 'followUp' as never,
    }),
  ).toMatchObject({
    success: false,
    error: 'streamingBehavior must be steer',
  })
  expect(
    await rpc.call({ type: 'steer', message: 'Change course' }),
  ).toMatchObject({
    data: { disposition: 'queued' },
  })
  expect((await rpc.call({ type: 'get_state' })).data).toMatchObject({
    isStreaming: true,
    pendingMessageCount: 1,
  })
  expect(
    rpc.records.filter((r) => r.type === 'queue_update').at(-1),
  ).toMatchObject({
    steering: ['Change course'],
  })

  // Renaming while running: not saved separately (it would interleave with the loop's writes); saved when this run ends
  expect(
    await rpc.call({ type: 'set_session_name', name: 'Renamed while running' }),
  ).toMatchObject({ success: true })

  expect((await rpc.call({ type: 'clear_queue' })).data).toEqual({
    steering: ['Change course'],
  })
  expect(await rpc.call({ type: 'abort' })).toMatchObject({ success: true })
  // The abort response comes after the session has really stopped
  const abortIndex = rpc.records.findIndex((r) => r.command === 'abort')
  const settledIndex = rpc.records.findIndex((r) => r.type === 'agent_settled')
  expect(settledIndex).toBeGreaterThan(-1)
  expect(settledIndex).toBeLessThan(abortIndex)
  expect(rpc.records.find((r) => r.type === 'agent_end')).toMatchObject({
    reason: 'aborted',
  })
  const list = await rpc.call({ type: 'list_sessions' })
  expect((list.data as { sessions: unknown[] }).sessions).toEqual([
    expect.objectContaining({
      name: 'Renamed while running',
      firstMessage: 'Think slowly',
    }),
  ])

  expect(await rpc.close()).toBe(0)
})

test.concurrent('rpc: a prompt that fails before the loop starts gets a failed response', async () => {
  // No model configured: prompt first answers started, then success:false once resolving the model fails (as in pi)
  const rpc = startRpc('')

  rpc.send({ id: 'p1', type: 'prompt', message: 'Hello' })
  expect(
    await rpc.waitFor((r) => r.id === 'p1' && r.success === true),
  ).toMatchObject({ data: { disposition: 'started' } })
  const failed = await rpc.waitFor((r) => r.id === 'p1' && r.success === false)
  expect(failed).toMatchObject({ type: 'response', command: 'prompt' })
  // The CLI's hint on how to pick a model, not the SDK's createVela() / setModel() hint
  expect(String(failed.error)).toContain(
    'No model available. Run vela setup; Sign in with /login',
  )
  expect(String(failed.error)).not.toContain('createVela')
  const compact = await rpc.call({ type: 'compact' })
  expect(compact).toMatchObject({ success: false })
  expect(String(compact.error)).toContain('or use --model provider/id')
  // Errors inside the loop are reported once in agent_end, not repeated as a response
  expect(rpc.records.some((r) => r.type === 'agent_start')).toBe(false)

  expect(await rpc.close()).toBe(0)
})

test.concurrent('rpc: compacting an empty session says there is nothing to compact', async () => {
  const rpc = startRpc(`faux:${scenario('hello')}`)
  const compact = await rpc.call({ type: 'compact' })
  // Like pi: a clear error instead of the automatic compaction's "no split point" message
  expect(compact).toMatchObject({
    success: false,
    error: 'Nothing to compact (session too small)',
  })
  expect(await rpc.close()).toBe(0)
})

test.concurrent('rpc: extension commands emit notify events over the stream', async () => {
  const rpc = startRpc(`faux:${scenario('hello')}`, [], {
    'extensions/ask.ts': `export default (vela) => vela.registerCommand('ask', {
  handler: async (_args, ctx) => {
    ctx.notify('hello from extension', 'info')
  },
})`,
  })

  rpc.send({ id: 'cmd', type: 'prompt', message: '/ask' })
  expect(await rpc.waitFor((r) => r.type === 'notify')).toMatchObject({
    type: 'notify',
    message: 'hello from extension',
    level: 'info',
  })
  expect(await rpc.waitFor((r) => r.id === 'cmd')).toMatchObject({
    data: { disposition: 'handled' },
  })

  expect(await rpc.close()).toBe(0)
})

test.concurrent('rpc: get_commands lists extension commands, prompt templates and skills with their source (like pi)', async () => {
  const rpc = startRpc(`faux:${scenario('hello')}`, [], {
    'prompts/fix.md': '---\ndescription: Fix a bug\n---\nFix $1',
    'skills/review/SKILL.md': '---\ndescription: Review a change\n---\nReview',
  })
  const { commands } = (await rpc.call({ type: 'get_commands' })).data as {
    commands: { name: string; description?: string; source: string }[]
  }
  expect(commands).toContainEqual({
    name: 'fix',
    description: 'Fix a bug',
    source: 'prompt',
  })
  expect(commands).toContainEqual({
    name: 'skill:review',
    description: 'Review a change',
    source: 'skill',
  })
  expect(commands).toContainEqual(
    expect.objectContaining({
      name: 'memory',
      extension: 'memory',
      source: 'extension',
    }),
  )
  await rpc.close()
})

test.concurrent('rpc: session tree commands follow pi (get_tree, get_entries, get_fork_messages, fork, clone, export_html, set_auto_compaction)', async () => {
  const rpc = startRpc(`faux:${scenario('hello')}`)
  await rpc.call({ type: 'prompt', message: 'Hello' })
  const settled = await rpc.waitFor((r) => r.type === 'agent_settled')
  const sessionId = settled.sessionId as string

  const tree = (await rpc.call({ type: 'get_tree' })).data as {
    tree: unknown[]
    leafId: string
  }
  expect(tree.tree).toHaveLength(1)
  const entries = (await rpc.call({ type: 'get_entries' })).data as {
    entries: { id: string }[]
    leafId: string
  }
  expect(entries.leafId).toBe(tree.leafId)
  const since = (
    await rpc.call({ type: 'get_entries', since: entries.entries.at(-2)!.id })
  ).data as { entries: unknown[] }
  expect(since.entries).toHaveLength(1)
  const forkMessages = (await rpc.call({ type: 'get_fork_messages' })).data as {
    messages: { entryId: string; text: string }[]
  }
  expect(forkMessages.messages).toEqual([
    { entryId: expect.any(String), text: 'Hello' },
  ])

  expect(
    await rpc.call({ type: 'set_auto_compaction', enabled: false }),
  ).toMatchObject({ success: true })
  expect((await rpc.call({ type: 'get_state' })).data).toMatchObject({
    autoCompactionEnabled: false,
  })
  const exported = await rpc.call({
    type: 'export_html',
    outputPath: 'out.html',
  })
  expect((exported.data as { path: string }).path).toEndWith('out.html')

  expect(await rpc.call({ type: 'clone' })).toMatchObject({
    success: true,
    data: { cancelled: false },
  })
  const cloned = (await rpc.call({ type: 'get_state' })).data as {
    sessionId: string
    messageCount: number
  }
  expect(cloned.sessionId).not.toBe(sessionId)
  expect(cloned.messageCount).toBe(2)

  expect(
    await rpc.call({
      type: 'fork',
      entryId: forkMessages.messages[0]!.entryId,
    }),
  ).toMatchObject({ success: true, data: { text: 'Hello', cancelled: false } })
  expect((await rpc.call({ type: 'get_state' })).data).toMatchObject({
    messageCount: 0,
  })
})

test.concurrent('rpc: bash runs a command for the user and answers with its result; abort_bash cancels it (like pi)', async () => {
  const rpc = startRpc(`faux:${scenario('hello')}`)

  rpc.send({ id: 'b1', type: 'bash', command: 'echo hi; exit 2' })
  expect(
    await rpc.waitFor((r) => r.type === 'response' && r.id === 'b1'),
  ).toMatchObject({
    command: 'bash',
    success: true,
    data: { output: 'hi', exitCode: 2, cancelled: false, truncated: false },
  })
  // The output also streamed as events carrying the command's id
  expect(
    rpc.records
      .filter((r) => r.type === 'bash_execution_update' && r.id === 'b1')
      .map((r) => r.delta)
      .join(''),
  ).toBe('hi\n')
  // It is in the context the next prompt sends
  const messages = await rpc.call({ type: 'get_messages' })
  expect((messages.data as { messages: unknown[] }).messages).toEqual([
    {
      role: 'user',
      content:
        'Ran `echo hi; exit 2`\n```\nhi\n```\n\nCommand exited with code 2',
    },
  ])

  const id = 'long'
  rpc.send({
    id,
    type: 'bash',
    command: 'echo started; sleep 10',
    excludeFromContext: true,
  })
  // Output arrives while the command runs
  expect(
    await rpc.waitFor((r) => r.type === 'bash_execution_update' && r.id === id),
  ).toMatchObject({ delta: 'started\n' })
  expect(await rpc.call({ type: 'abort_bash' })).toMatchObject({
    success: true,
  })
  expect(
    await rpc.waitFor((r) => r.type === 'response' && r.id === id),
  ).toMatchObject({ success: true, data: { cancelled: true } })
  expect(
    ((await rpc.call({ type: 'get_messages' })).data as { messages: unknown[] })
      .messages,
  ).toHaveLength(1)
  expect(await rpc.close()).toBe(0)
})

test.concurrent('rpc: prompt and steer forward canonical image attachments; follow_up is removed', async () => {
  for (const type of ['prompt', 'steer']) {
    const rpc = startRpc(`faux:${scenario('hello')}`)
    try {
      const image = {
        type: 'image',
        data: await Bun.file(join(ROOT, 'test/fixtures/images/blue.png'))
          .arrayBuffer()
          .then((b) => Buffer.from(b).toString('base64')),
        mimeType: 'image/png',
      }
      expect(
        await rpc.call({
          type,
          message: 'Describe the picture',
          images: [image],
        }),
      ).toMatchObject({ success: true })
      await rpc.waitFor((r) => r.type === 'agent_settled')
      const history = await rpc.call({ type: 'get_messages' })
      expect(JSON.stringify(history.data)).toContain(image.data)
      expect(JSON.stringify(history.data)).toContain('"mimeType":"image/png"')
    } finally {
      expect(await rpc.close()).toBe(0)
    }
  }
  const rpc = startRpc(`faux:${scenario('hello')}`)
  try {
    expect(
      await rpc.call({ type: 'follow_up', message: 'Later' }),
    ).toMatchObject({
      success: false,
      error: 'Unknown command: follow_up',
    })
  } finally {
    expect(await rpc.close()).toBe(0)
  }
})

const alphaContrast = (data: string) => {
  const image = PhotonImage.new_from_byteslice(Buffer.from(data, 'base64'))
  try {
    const raw = image.get_raw_pixels()
    let opaqueDark = 0
    let transparent = 0
    for (let i = 0; i < raw.length; i += 4) {
      const alpha = raw[i + 3] ?? 0
      const rgb = (raw[i] ?? 0) + (raw[i + 1] ?? 0) + (raw[i + 2] ?? 0)
      if (alpha < 16) transparent++
      if (alpha > 200 && rgb < 48) opaqueDark++
    }
    const count = raw.length / 4
    return {
      longest: Math.max(image.get_width(), image.get_height()),
      opaqueDark: opaqueDark / count,
      transparent: transparent / count,
    }
  } finally {
    image.free()
  }
}

test.concurrent('rpc: resized transparent PNG keeps dark lines in prompt history', async () => {
  const rpc = startRpc(`faux:${scenario('hello')}`)
  try {
    const image = {
      type: 'image',
      data: await Bun.file(
        join(ROOT, 'test/fixtures/images/transparent-lines.png'),
      )
        .arrayBuffer()
        .then((bytes) => Buffer.from(bytes).toString('base64')),
      mimeType: 'image/png',
    }
    expect(
      await rpc.call({
        type: 'prompt',
        message: 'what is in this diagram?',
        images: [image],
      }),
    ).toMatchObject({ success: true })
    await rpc.waitFor((record) => record.type === 'agent_settled')
    const history = await rpc.call({ type: 'get_messages' })
    const saved = (
      history.data as {
        messages: {
          content?: { type?: string; data?: string; mimeType?: string }[]
        }[]
      }
    ).messages
      .flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      )
      .find((part) => part.type === 'image')
    expect(saved?.mimeType).toBe('image/png')
    expect(saved?.data).not.toBe(image.data)
    if (!saved?.data) throw new Error('history image missing')
    expect(saved.data.length).toBeLessThanOrEqual(4.5 * 1024 * 1024)
    const seen = alphaContrast(saved.data)
    expect(seen.longest).toBeLessThanOrEqual(2000)
    expect(seen.opaqueDark).toBeGreaterThan(0.02)
    expect(seen.transparent).toBeGreaterThan(0.5)
  } finally {
    expect(await rpc.close()).toBe(0)
  }
})

test.concurrent('rpc: malformed image arrays fail clearly and a later valid prompt still runs', async () => {
  const rpc = startRpc(`faux:${scenario('hello')}`)
  try {
    for (const type of ['prompt', 'steer']) {
      for (const images of [
        { data: 'x' },
        [null],
        [{ type: 'image', data: 2, mimeType: 'image/png' }],
      ]) {
        expect(await rpc.call({ type, message: 'bad', images })).toMatchObject({
          success: false,
          error: expect.stringContaining('images'),
        })
      }
    }
    expect(await rpc.call({ type: 'prompt', message: 'hello' })).toMatchObject({
      success: true,
    })
    await rpc.waitFor((r) => r.type === 'agent_settled')
  } finally {
    expect(await rpc.close()).toBe(0)
  }
})

test('rpc: a failed project tool selection leaves the active session and can be retried', async () => {
  const a = tempDir('vela-rpc-a-')
  const b = tempDir('vela-rpc-b-')
  const home = tempDir('vela-rpc-home-')
  dirs.push(b)
  mkdirSync(join(b.path, '.vela'))
  const settings = join(b.path, '.vela', 'config.json')
  const files = {
    'config.json': JSON.stringify({ dataDir: join(home.path, 'data') }),
    'trust.json': JSON.stringify({ [a.path]: true, [b.path]: true }),
  }
  writeFileSync(settings, JSON.stringify({ tools: ['read'] }))
  const model = `faux:${scenario('hello')}`
  const seed = startRpc(model, ['--session', 'saved-b'], files, {
    cwd: b,
    home,
  })
  try {
    expect(
      await seed.call({ type: 'prompt', message: 'Save B' }),
    ).toMatchObject({ success: true })
    await seed.waitFor((record) => record.type === 'agent_settled')
  } finally {
    await seed.close()
  }
  writeFileSync(settings, JSON.stringify({ tools: ['stale_project_tool'] }))
  const rpc = startRpc(model, ['--session', 'active-a'], files, {
    cwd: a,
    home,
  })
  try {
    expect(
      await rpc.call({ type: 'switch_session', sessionId: 'saved-b' }),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining('stale_project_tool'),
    })
    expect((await rpc.call({ type: 'get_state' })).data).toMatchObject({
      sessionId: 'active-a',
    })
    writeFileSync(settings, JSON.stringify({ tools: ['read'] }))
    expect(
      await rpc.call({ type: 'switch_session', sessionId: 'saved-b' }),
    ).toMatchObject({
      success: true,
      data: { sessionId: 'saved-b' },
    })
  } finally {
    await rpc.close()
  }
})

test.concurrent('rpc: background_tasks moves one bash call by id, or every running call', async () => {
  const rpc = startRpc(`faux:${scenario('slow-bash')}`)
  try {
    expect(
      await rpc.call({ type: 'prompt', message: 'Run the slow checks' }),
    ).toMatchObject({ success: true, data: { disposition: 'started' } })
    // Wait until both commands have produced output, like a client pressing the key mid-run.
    const updates = new Map<string, unknown>()
    for (;;) {
      const record = await rpc.waitFor(
        (r) =>
          r.type === 'tool_execution_update' &&
          r.toolName === 'bash' &&
          !updates.has(r.toolCallId as string),
      )
      updates.set(record.toolCallId as string, record)
      if (updates.size === 2) break
    }
    // The ids arrive in an order the model's parallel calls decide, so sort them like the error does.
    const [first, second] = [...updates.keys()].sort() as [string, string]
    // An unknown id is a response error that names what is running, and changes nothing.
    expect(
      await rpc.call({ type: 'background_tasks', tool_use_id: 'not-a-call' }),
    ).toMatchObject({
      command: 'background_tasks',
      success: false,
      error: expect.stringContaining(
        `No running bash call with tool call ID not-a-call. Running: ${first}, ${second}`,
      ),
    })
    expect(
      await rpc.call({ type: 'background_tasks', tool_use_id: first }),
    ).toMatchObject({ success: true, data: { ids: ['bg-1'] } })
    // Without an id, every call still in the foreground moves.
    expect(await rpc.call({ type: 'background_tasks' })).toMatchObject({
      success: true,
      data: { ids: ['bg-2'] },
    })
    await rpc.waitFor((r) => r.type === 'agent_settled')
    const messages = await rpc.call({ type: 'get_messages' })
    const text = JSON.stringify(
      (messages.data as { messages: unknown[] }).messages,
    )
    expect(text).toContain(
      'Command was manually moved to the background with ID: bg-1.',
    )
    expect(text).toContain(
      'Command was manually moved to the background with ID: bg-2.',
    )
    expect(text).toContain('ONE')
    expect(text).toContain('TWO')
  } finally {
    // Closing ends the session, which stops both jobs without delivering.
    await rpc.close()
  }
})
