import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import type { ModelMessage } from 'ai'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

const entries = async (t: ReturnType<typeof createTestVela>) =>
  (await t.readData('sessions/default.jsonl'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))

const userTexts = (messages: readonly ModelMessage[]) =>
  messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)

test('`!` runs a command, records it and sends it to the model with the next prompt (like pi)', async () => {
  const t = createTestVela({
    responses: [(req) => fauxText(JSON.stringify(req.prompt))],
  })
  const updates: string[] = []
  const result = await t.session.executeBash('echo hi; exit 3', {
    onUpdate: (output) => updates.push(output),
  })
  expect(result).toEqual({
    output: 'hi',
    exitCode: 3,
    cancelled: false,
    truncated: false,
  })
  expect(userTexts(t.messages)).toEqual([
    'Ran `echo hi; exit 3`\n```\nhi\n```\n\nCommand exited with code 3',
  ])
  // Written right away, and it starts the session file like a user message
  const saved = (await entries(t)).filter((e) => e.type === 'bash_execution')
  expect(saved).toEqual([
    expect.objectContaining({
      command: 'echo hi; exit 3',
      output: 'hi',
      exitCode: 3,
      cancelled: false,
      truncated: false,
    }),
  ])
  await t.run('what happened?')
  expect(t.lastAssistantText()).toContain('Ran `echo hi; exit 3`')
  expect(t.eventsOf('message_start')).toHaveLength(2)
})

test('`!!` is recorded but never sent to the model', async () => {
  const t = createTestVela({
    responses: [(req) => fauxText(JSON.stringify(req.prompt))],
  })
  await t.session.executeBash('echo secret', { excludeFromContext: true })
  expect(t.messages).toEqual([])
  await t.run('hello')
  expect(t.lastAssistantText()).not.toContain('secret')
  expect(
    (await entries(t)).find((e) => e.type === 'bash_execution'),
  ).toMatchObject({ command: 'echo secret', excludeFromContext: true })

  // Resumed: still kept out of the context
  await t.session.close()
  const resumed = t.vela.session('default')
  expect(await resumed.resume()).toBe(true)
  expect(JSON.stringify(resumed.messages)).not.toContain('secret')
})

test('a command that finishes while the agent runs is recorded after the run, not between a tool call and its result', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', { command: 'sleep 0.3' }),
      fauxText('done'),
      (req) => fauxText(JSON.stringify(req.prompt)),
    ],
  })
  let started!: () => void
  const toolStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  t.session.subscribe((event) => {
    if (event.type === 'tool_execution_start') started()
  })
  const running = t.run('go')
  await toolStarted
  const result = await t.session.executeBash('echo side')
  expect(result.output).toBe('side')
  // Still running: not in the history yet
  expect(JSON.stringify(t.messages)).not.toContain('echo side')
  await running
  expect(t.messages.map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'tool',
    'assistant',
    'user',
  ])
  expect(
    (await entries(t))
      .filter((e) => e.type === 'message' || e.type === 'bash_execution')
      .map((e) => (e.type === 'message' ? e.message.role : e.type)),
  ).toEqual(['user', 'assistant', 'tool', 'assistant', 'bash_execution'])
  await t.run('next')
  expect(t.lastAssistantText()).toContain('Ran `echo side`')
})

test('abortBash() cancels the command, which is still recorded as cancelled', async () => {
  const t = createTestVela()
  const running = t.session.executeBash('echo started; sleep 10')
  while (!t.session.isBashRunning) await Bun.sleep(1)
  await expect(t.session.executeBash('echo two')).rejects.toThrow(
    'already running',
  )
  await Bun.sleep(100)
  t.session.abortBash()
  const result = await running
  expect(result).toMatchObject({ cancelled: true, exitCode: undefined })
  expect(t.session.isBashRunning as boolean).toBe(false)
  expect(userTexts(t.messages).at(-1)).toContain('(command cancelled)')
})

test('long output keeps its end and points to the full output file', async () => {
  const t = createTestVela()
  const result = await t.session.executeBash('seq 1 3000')
  expect(result.truncated).toBe(true)
  expect(result.output.split('\n')).toHaveLength(2000)
  expect(result.output.endsWith('3000')).toBe(true)
  expect(result.fullOutputPath).toBeString()
  expect(userTexts(t.messages).at(-1)).toContain(
    `[Output truncated. Full output: ${result.fullOutputPath}]`,
  )
})

test('only the owner can run commands, and not on a saved session that was not resumed', async () => {
  const t = createTestVela()
  const guest = t.vela.session('guest-chat', { role: 'guest' })
  await expect(guest.executeBash('echo hi')).rejects.toThrow('owner')

  await t.session.executeBash('echo saved')
  await t.cleanup({ keepDir: true })
  const second = createTestVela({ cwd: t.cwd })
  try {
    await expect(second.session.executeBash('echo hi')).rejects.toThrow(
      'already has saved history',
    )
    expect(await second.session.resume()).toBe(true)
    expect(userTexts(second.messages)).toEqual([
      'Ran `echo saved`\n```\nsaved\n```',
    ])
  } finally {
    await second.cleanup()
    rmSync(t.cwd, { recursive: true, force: true })
  }
})

test("tool messages record each tool's details, so a resumed session can show edit diffs", async () => {
  const t = createTestVela({
    files: { 'a.txt': 'one\n' },
    responses: [
      fauxToolCall('edit_file', {
        path: 'a.txt',
        edits: [{ oldText: 'one', newText: 'two' }],
      }),
      fauxText('edited'),
    ],
  })
  await t.run('edit a.txt')
  const tool = (await entries(t)).find(
    (e) => e.type === 'message' && e.message.role === 'tool',
  )
  const callId = tool.message.content[0].toolCallId
  expect(tool.details[callId].diff).toContain('+1 two')
  expect(t.session.getEntries()).toContainEqual(
    expect.objectContaining({ details: tool.details }),
  )
})
