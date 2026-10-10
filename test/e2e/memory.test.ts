import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { MemoryStore } from '../../src/extensions/memory/store.ts'
import { fauxHang, fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import {
  captureConsole,
  cleanupTestVelas,
  createTestVela,
  type TestVela,
} from '../support/vela.ts'

afterEach(cleanupTestVelas)

const save = {
  action: 'save',
  name: 'favorite-language',
  description: "The user's favorite programming language",
  type: 'user',
  content: 'The user likes TypeScript best',
}

test('a memory saved through the tool shows up in the next system prompt and survives a restart', async () => {
  const t = createTestVela({
    responses: [
      (req) => {
        expect(req.system).toContain('No memories stored yet')
        return fauxToolCall('memory', save)
      },
      fauxText('Got it'),
      (req) => {
        expect(req.system).toContain("The user's favorite programming language")
        return fauxText('You like TypeScript')
      },
    ],
  })

  await t.run('Remember: TypeScript is my favorite')
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain('Saved to memory')
  await t.run('What is my favorite language?')
  expect(t.lastAssistantText()).toBe('You like TypeScript')

  const index = await t.readData('memory/MEMORY.md')
  expect(index).toContain('favorite-language')

  // A new session: the saved default session would need resume()
  const restarted = createTestVela({
    cwd: t.cwd,
    sessionId: 'after-restart',
    responses: [fauxText('ok')],
  })
  await restarted.run('Hello')
  expect(restarted.model.calls[0]!.system).toContain(
    "The user's favorite programming language",
  )
})

test('the model can search and read memories back', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('memory', save),
      fauxToolCall('memory', {
        action: 'search',
        query: 'TypeScript',
        filename: '',
      }),
      (req) => {
        expect(req.toolResults[0]!.output).toContain('favorite-language')
        return fauxText('Found it')
      },
    ],
  })
  await t.run('Save it, then find it again')
  expect(t.lastAssistantText()).toBe('Found it')
})

test('the memory tool rejects a save without content', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('memory', {
        action: 'save',
        name: 'x',
        type: 'user',
        filename: '',
      }),
      fauxText('OK'),
    ],
  })
  await t.run('Save an empty one')
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain('Save failed')
  expect(new MemoryStore(join(t.dataDir, 'memory')).list()).toHaveLength(0)
})

test('read and delete need a filename; with one they work', async () => {
  const t = createTestVela({
    responses: [
      [
        fauxToolCall('memory', { action: 'read' }),
        fauxToolCall('memory', { action: 'delete' }),
      ],
      fauxToolCall('memory', save),
      fauxToolCall('memory', { action: 'list' }),
      (req) => {
        const filename =
          req.toolResults[0]!.output.match(/\S+\.md/)?.[0] ??
          'user_favorite-language.md'
        return fauxToolCall('memory', { action: 'delete', filename })
      },
      fauxText('Deleted it'),
    ],
  })
  await t.run('Read, delete, save, list, delete')
  const outputs = t.model.calls[1]!.toolResults.map((r) => r.output).join('\n')
  expect(outputs).toContain('Read failed: filename is required')
  expect(outputs).toContain('Delete failed: filename is required')
  expect(t.model.calls[4]!.toolResults[0]!.output).toContain('Deleted')
  expect(new MemoryStore(join(t.dataDir, 'memory')).list()).toHaveLength(0)
})

// ---------- Commands (registered by the memory extension; output goes through ui.notify) ----------

function withMemory(options: Parameters<typeof createTestVela>[0] = {}) {
  const t = createTestVela(options)
  new MemoryStore(join(t.dataDir, 'memory')).save({
    name: 'openai-null-chars',
    description: 'openai API returns null characters',
    type: 'feedback',
    content: 'Body',
  })
  return t
}

const notes = (t: TestVela) =>
  t
    .eventsOf('notify')
    .map((e) => e.message)
    .join('\n')

test('/memory lists memories, /memory search uses BM25, /memory lint reports health', async () => {
  const t = withMemory()
  await t.run('/memory')
  expect(notes(t)).toContain('1 memories')
  expect(notes(t)).toContain('openai-null-chars')
  await t.run('/memory search null characters')
  expect(notes(t)).toContain('BM25 search')
  await t.run('/memory lint')
  expect(notes(t)).toContain('Memory store is healthy')
  // Commands are not sent to the model
  expect(t.model.calls).toHaveLength(0)
})

test('/dream hands the memory clean-up prompt to the model', async () => {
  const t = withMemory({ responses: [fauxText('Memories cleaned up')] })
  await t.run('/dream')
  expect(t.model.calls).toHaveLength(1)
  expect(t.model.calls[0]!.lastUserText).toContain('memory lint')
  expect(t.lastAssistantText()).toBe('Memories cleaned up')
  expect(notes(t)).toContain('[dream] Done')
  expect(t.session.busy.locked).toBe(false)
})

test('/context previews the memory section before the first prompt', async () => {
  const t = withMemory()
  // Sections are computed per prompt; before the first prompt this round is empty
  expect(t.session.promptContext().extensionSections?.memory).toBeUndefined()
  const sections = await t.session.previewSections()
  expect(sections.memory).toContain('openai-null-chars')
  expect(t.session.buildSystem(sections)).toContain('openai-null-chars')
  // The preview does not replace this round's sections
  expect(t.session.promptContext().extensionSections?.memory).toBeUndefined()
  const { output } = await captureConsole(() => t.command('/context'))
  // This used to show 0 tokens before the first prompt
  const memoryRow = output.split('\n').find((line) => line.includes('Memory'))
  expect(memoryRow).toBeDefined()
  expect(memoryRow).not.toMatch(/\b0 tokens/)
  expect(t.model.calls).toHaveLength(0)
})

test('aborting the prompt signal of /dream stops the model run it started', async () => {
  const t = withMemory({ responses: [fauxHang()] })
  const controller = new AbortController()
  const run = t.run('/dream', { signal: controller.signal })
  while (t.model.calls.length === 0) await Bun.sleep(1)
  controller.abort(new Error('stop dream'))
  await expect(run).rejects.toThrow()
  expect(t.eventsOf('agent_end').at(-1)?.reason).toBe('aborted')
  expect(t.session.busy.locked).toBe(false)
})

test('guest sessions cannot run memory commands; the text goes to the model', async () => {
  const t = withMemory({
    responses: [fauxText('Plain answer')],
    session: { role: 'guest' },
  })
  await t.run('/memory')
  expect(notes(t)).not.toContain('openai-null-chars')
  expect(t.model.calls).toHaveLength(1)
})
