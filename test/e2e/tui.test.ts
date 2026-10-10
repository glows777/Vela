import { afterEach, expect, test } from 'bun:test'
import z from 'zod'
import confirmDangerous from '../../examples/extensions/confirm-dangerous.ts'
import todo from '../../examples/extensions/todo-command.ts'
import type { ProviderDefinition } from '../../src/models/index.ts'
import {
  createFauxModel,
  fauxHang,
  fauxStreamError,
  fauxText,
  fauxToolCall,
} from '../../src/testing/faux.ts'
import { KEYS, startTui, stopTuis } from '../support/terminal.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(async () => {
  await stopTuis()
  await cleanupTestVelas()
})

// Interactive mode (pi-tui) runs in a fake terminal: keys go straight to the TUI, and assertions check the rendered screen text.

test('a prompt shows the user message, tool calls with results and the streamed answer', async () => {
  const t = createTestVela({
    files: { 'a.txt': 'hello from a' },
    responses: [
      fauxToolCall('read_file', { path: 'a.txt' }),
      fauxText('**The file** says hello'),
    ],
  })
  const tui = await startTui(t.vela)
  await tui.started

  tui.submit('read a.txt')
  await tui.until('The file says hello')

  const screen = tui.screen()
  expect(screen).toContain('read a.txt')
  expect(screen).toContain('read_file a.txt')
  expect(screen).toContain('hello from a')
  // Footer: session, model, thinking
  expect(screen).toContain('tui')
  expect(screen).toMatch(/faux.* · medium/)
  await tui.until(() => !t.vela.session('tui').isRunning)
  expect(tui.screen()).not.toContain('Esc to interrupt)')
})

test('a retried response keeps its partial text marked as failed, and the retry is a new message (like pi)', async () => {
  const t = createTestVela({
    responses: [
      fauxStreamError('ECONNRESET', 'Half an ans'),
      fauxText('The full answer'),
    ],
  })
  const tui = await startTui(t.vela)
  await tui.started

  tui.submit('hi')
  await tui.until('The full answer')

  const screen = tui.screen()
  expect(screen).toContain('Half an ans')
  expect(screen).toContain('(response failed)')
  expect(screen).toContain('Request failed, retrying')
  expect(screen.indexOf('(response failed)')).toBeLessThan(
    screen.indexOf('The full answer'),
  )
})

test('Enter while running steers, Alt+Enter queues a follow-up, Esc puts the queue back and aborts', async () => {
  const t = createTestVela({ responses: [fauxHang('Let me see')] })
  const tui = await startTui(t.vela)
  await tui.started
  tui.submit('Take your time')
  await tui.until('Let me see')
  const session = t.vela.session('tui')
  expect(session.isRunning).toBe(true)

  tui.submit('one more thing')
  tui.terminal.type('do this later')
  tui.terminal.press(KEYS.altEnter)
  await tui.until('Follow-up: do this later')
  expect(session.queue).toEqual({
    steering: ['one more thing'],
    followUp: ['do this later'],
  })
  expect(tui.screen()).toContain('Steering: one more thing')

  tui.terminal.press(KEYS.escape)
  await tui.until('Interrupted')
  await tui.until(() => !session.isRunning)
  expect(session.queue).toEqual({ steering: [], followUp: [] })
  // The queued messages are back in the editor
  expect(tui.screen()).toContain('one more thing')
  expect(tui.screen()).toContain('do this later')
  expect(tui.screen()).not.toContain('Follow-up:')
})

test('a steer typed while the model streams is answered in the same run', async () => {
  let tui!: Awaited<ReturnType<typeof startTui>>
  const t = createTestVela({
    responses: [
      () => {
        tui.submit('also this')
        return fauxText('first reply')
      },
      fauxText('second reply'),
    ],
  })
  tui = await startTui(t.vela)
  await tui.started
  tui.submit('say something')
  await tui.until('second reply')
  expect(t.model.calls.map((c) => c.lastUserText)).toEqual([
    'say something',
    'also this',
  ])
})

test('an extension confirm opens a dialog in place of the editor', async () => {
  const t = createTestVela({
    extensions: [confirmDangerous],
    responses: [
      fauxToolCall('bash', { command: 'rm -rf build' }),
      fauxText('Okay, skipped'),
    ],
  })
  const tui = await startTui(t.vela)
  await tui.started
  tui.submit('clean up')
  await tui.until('Delete files?')
  expect(tui.screen()).toContain('rm -rf build')
  // Choose "No": Down, then Enter
  tui.terminal.press(KEYS.down)
  tui.terminal.press(KEYS.enter)
  await tui.until('Okay, skipped')
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain(
    'User did not allow the deletion',
  )
})

test('slash commands: CLI command output, extension commands and /hotkeys go to the chat', async () => {
  const t = createTestVela({ extensions: [todo] })
  const tui = await startTui(t.vela)
  await tui.started

  tui.submit('/extensions')
  // Output a command prints line by line is joined into one block without blank lines
  await tui.until('[extensions]\n   memory\n     Tools: memory')
  tui.submit('/todo buy milk')
  await tui.until('buy milk')
  tui.submit('/hotkeys')
  await tui.until('Alt+Up move queued messages back to the editor')
})

test('terminal control sequences in tool output and channel messages are not written to the terminal', async () => {
  const t = createTestVela({
    files: { 'a.txt': 'x\x1b]0;PWNED\x07y\x1b[31mred\x1b]52;c;ZXZpbA==\x07' },
    responses: [
      fauxToolCall('read_file', { path: 'a.txt' }),
      fauxText('done'),
      fauxText('reply'),
    ],
  })
  t.internals.gateway.register({
    name: 'fake',
    description: 'test channel',
    start: () => {},
    stop: () => {},
    send: async () => {},
  })
  const tui = await startTui(t.vela)
  await tui.started
  tui.submit('read a.txt')
  await tui.until('done')
  await tui.until(() => !t.vela.session('tui').isRunning)
  // A message from someone in a channel (untrusted)
  await t.internals.gateway.handleIncoming('fake', {
    channelId: 'c1',
    senderId: 'guest',
    senderName: 'guest',
    text: 'hi\x1b]0;PWNED\x07there',
  })
  await tui.until('[fake] guest: hithere')
  const raw = tui.mode.tui.render(100).join('\n')
  expect(raw).not.toContain(']0;PWNED')
  expect(raw).not.toContain(']52;')
  expect(tui.screen()).toContain('xyred')
})

test('SIGTERM shuts the TUI down like Ctrl+D', async () => {
  const t = createTestVela()
  const tui = await startTui(t.vela)
  await tui.started
  process.emit('SIGTERM')
  await tui.mode.exited
  expect(tui.exited()).toBe(true)
  expect(process.listenerCount('SIGTERM')).toBe(0)
})

test('slash commands still run while the agent is busy instead of being steered', async () => {
  const t = createTestVela({ responses: [fauxHang('Let me see')] })
  const tui = await startTui(t.vela)
  await tui.started
  tui.submit('Take your time')
  await tui.until('Let me see')
  tui.submit('/usage')
  await tui.until('Usage Summary')
  expect(t.vela.session('tui').queue.steering).toEqual([])
})

test('model and thinking selectors; Shift+Tab cycles thinking', async () => {
  const big = createFauxModel({ modelId: 'big' })
  const plain = createFauxModel({ modelId: 'plain' })
  const provider: ProviderDefinition = {
    models: [{ id: 'big', contextWindow: 32_768 }, { id: 'plain' }],
    createModel: (id) => (id === 'big' ? big : plain),
  }
  const t = createTestVela({ model: 'fake/big', providers: { fake: provider } })
  const tui = await startTui(t.vela)
  await tui.started
  const session = t.vela.session('tui')

  tui.terminal.press(KEYS.ctrlL)
  await tui.until('Select Model')
  expect(tui.screen()).toContain('fake/big ✓')
  // The cursor starts on the current model
  tui.terminal.press(KEYS.down)
  tui.terminal.press(KEYS.enter)
  await tui.until('Model: fake/plain')
  expect(session.modelInfo.ref).toBe('fake/plain')

  tui.submit('/thinking')
  await tui.until('Thinking level')
  tui.terminal.press(KEYS.down)
  tui.terminal.press(KEYS.enter)
  await tui.until(() => session.thinkingLevel === 'high')

  tui.terminal.press(KEYS.shiftTab)
  expect(session.thinkingLevel).toBe('xhigh')
})

test('/name, /new and /resume switch between saved sessions', async () => {
  const t = createTestVela({
    responses: [fauxText('answer in the first session')],
  })
  const tui = await startTui(t.vela, { sessionId: 'first' })
  await tui.started
  tui.submit('Hi there')
  await tui.until('answer in the first session')
  await tui.until(() => !t.vela.session('first').isRunning)
  tui.submit('/name greeting')
  await tui.until('Session name: greeting')

  tui.submit('/new')
  await tui.until('session tui-new-1')
  expect(tui.screen()).not.toContain('answer in the first session')

  tui.submit('/resume')
  await tui.until('Resume Session')
  expect(tui.screen()).toContain('greeting')
  tui.terminal.press(KEYS.enter)
  await tui.until('Resumed session greeting')
  // The history is drawn again
  expect(tui.screen()).toContain('answer in the first session')
  expect(tui.screen()).toContain('Hi there')
})

test('-r picks a saved session before the chat starts', async () => {
  const t = createTestVela({ responses: [fauxText('old answer')] })
  await t.vela.session('old').prompt('old question')
  const tui = await startTui(t.vela, { pick: true })
  await tui.until('Resume Session')
  tui.terminal.press(KEYS.enter)
  await tui.started
  await tui.until('old answer')
  expect(tui.screen()).toContain('session old')
})

test('Ctrl+C clears the editor, twice exits; Ctrl+D on an empty editor exits', async () => {
  const t = createTestVela()
  const tui = await startTui(t.vela)
  await tui.started
  tui.terminal.type('draft')
  await tui.until('draft')
  tui.terminal.press(KEYS.ctrlC)
  await tui.until(() => !tui.screen().includes('draft'))
  expect(tui.exited()).toBe(false)

  tui.terminal.press(KEYS.ctrlD)
  await tui.mode.exited
  expect(tui.exited()).toBe(true)
})

test('@ suggests files in the working directory (fd found on PATH, like pi)', async () => {
  const t = createTestVela({ files: { 'src/alpha-file.ts': 'export {}\n' } })
  const tui = await startTui(t.vela)
  await tui.started

  tui.terminal.type('read @alpha')
  await tui.until('src/alpha-file.ts')
})

test('/ suggests prompt templates (with their argument hint) and skills as skill:<name>', async () => {
  const t = createTestVela({
    files: {
      '.vela/prompts/fixbug.md':
        '---\ndescription: Fix a bug\nargument-hint: <file>\n---\nFix $1',
    },
    skills: [
      { name: 'reviewer', description: 'Review a change', body: 'Review' },
    ],
  })
  const tui = await startTui(t.vela)
  await tui.started

  tui.terminal.type('/fixb')
  await tui.until('<file> — Fix a bug')
  tui.terminal.press(KEYS.ctrlC)
  tui.terminal.type('/skill:rev')
  await tui.until('skill:reviewer')
})

test('bash output streams into its block while it runs; the block keeps the last lines and the time taken (like pi)', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'seq 1 12; echo out$((1+1)); sleep 1; echo end$((2+2))',
      }),
      fauxText('all done'),
    ],
  })
  const tui = await startTui(t.vela)
  await tui.started

  tui.submit('count')
  // Still running: the partial output is already on screen with a live clock
  // (the command line itself reads `out$((1+1))`, so `out2` can only come from the output)
  await tui.until('out2')
  expect(tui.screen()).not.toContain('end4')
  await tui.until('Elapsed')
  await tui.until('all done')

  const screen = tui.screen()
  expect(screen).toContain('$ seq 1 12')
  // Collapsed: only the last 5 lines
  expect(screen).toContain('… 9 earlier lines (Ctrl+O to expand)')
  expect(screen).toContain('end4')
  expect(screen).not.toMatch(/^\s*3\s*$/m)
  expect(screen).toMatch(/Took \d+\.\ds/)
})

test('edit_file shows the diff of its change', async () => {
  const t = createTestVela({
    files: { 'a.txt': 'one\ntwo\nthree\n' },
    responses: [
      fauxToolCall('edit_file', {
        path: 'a.txt',
        edits: [{ oldText: 'two', newText: 'TWO' }],
      }),
      fauxText('edited'),
    ],
  })
  const tui = await startTui(t.vela)
  await tui.started

  tui.submit('edit it')
  await tui.until('edited')

  const screen = tui.screen()
  expect(screen).toContain('edit_file a.txt')
  expect(screen).toContain('-2 two')
  expect(screen).toContain('+2 TWO')
  expect(screen).toContain(' 1 one')
  // The model's summary line is replaced by the diff
  expect(screen).not.toContain('Successfully replaced')
})

test('calls a tool makes through ctx.executeTool are listed inside its block', async () => {
  const t = createTestVela({
    files: { 'a.txt': 'hello' },
    responses: [fauxToolCall('runner', {}), fauxText('ran')],
  })
  t.internals.registry.register({
    name: 'runner',
    description: 'Runs other tools',
    inputSchema: z.object({}),
    execute: async (_input, context) => {
      await context!.executeTool!('read_file', { path: 'a.txt' })
      await context!.executeTool!('read_file', { path: 'missing.txt' })
      return 'ok'
    },
  })
  const tui = await startTui(t.vela)
  await tui.started

  tui.submit('run')
  await tui.until('ran')

  const screen = tui.screen()
  expect(screen).toMatch(/↳ ✓ read_file a\.txt \d+\.\ds/)
  expect(screen).toMatch(/↳ ✗ read_file missing\.txt/)
  // No separate blocks for the nested calls
  expect(screen.match(/read_file/g)).toHaveLength(2)
})

test('/copy copies the last answer to the clipboard (like pi)', async () => {
  const t = createTestVela({
    responses: [
      fauxText('The **answer**'),
      fauxToolCall('read_file', { path: 'missing.txt' }),
      fauxText(''),
    ],
  })
  const copied: string[] = []
  const tui = await startTui(t.vela, {
    copyToClipboard: async (text) => {
      copied.push(text)
    },
  })
  await tui.started

  tui.submit('/copy')
  await tui.until('No answer to copy yet')

  tui.submit('question')
  await tui.until('answer')
  await tui.until(() => !t.vela.session('tui').isRunning)
  // A later step with only a tool call and no text doesn't hide the last answer
  tui.submit('again')
  await tui.until(
    () => t.model.pending() === 0 && !t.vela.session('tui').isRunning,
  )
  tui.submit('/copy')
  await tui.until('Copied the last answer to the clipboard')
  expect(copied).toEqual(['The **answer**'])
})
