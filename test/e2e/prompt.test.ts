import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ChannelDefinition,
  IncomingMessage,
  ChannelExtension as VelaExtension,
} from '@glows777/vela-channels'
import { inspectSession } from '@glows777/vela-core/diagnostics'
import { fauxText, fauxToolCall } from '@glows777/vela-core/testing'
import { z } from 'zod'
import { createVela } from '../support/compat-vela.ts'
import { cleanupTestVelas, createTestVela, tempDir } from '../support/vela.ts'

afterEach(cleanupTestVelas)

/** The `<tools>` section of a system prompt, or '' when it has none */
function toolsSection(system: string): string {
  const start = system.indexOf('<tools>')
  const end = system.indexOf('</tools>')
  return start === -1 || end === -1 ? '' : system.slice(start, end)
}

test('the prompt lists exactly the tools the session can call, and no rule names another', async () => {
  const t = createTestVela({
    session: { tools: ['read_file', 'bash'] },
    responses: [fauxText('ok')],
  })
  await t.run('hello')
  const system = t.model.calls[0]!.system
  const tools = toolsSection(system)
  expect(tools).toContain('- read_file:')
  expect(tools).toContain('- bash:')
  for (const absent of ['edit_file', 'write_file', 'tool_search']) {
    expect(tools).not.toContain(absent)
    // No section advises a tool the model does not have
    expect(system).not.toContain(`${absent} with`)
  }
  expect(system).not.toContain('<deferred_tools>')
  expect(system).not.toContain('Read a file before you change it.')
})

test('the intro claims no capability, and the tools that are present still describe theirs', async () => {
  const intro = (prompt: string) => prompt.split('\n\n')[0]!
  const narrow = createTestVela({ session: { tools: ['read_file'] } })
  const narrowed = (await inspectSession(narrow.vela, narrow.session))
    .systemPrompt
  expect(intro(narrowed)).toBe(
    'You are Vela, an AI agent that helps users by calling the tools this session provides.',
  )
  expect(toolsSection(narrowed)).toContain('- read_file:')

  // A session with the execution tools keeps describing them, through `<tools>`
  const full = createTestVela()
  const system = (await inspectSession(full.vela, full.session)).systemPrompt
  expect(intro(system)).toBe(intro(narrowed))
  expect(system).toContain('- bash: Run a shell command')
  expect(system).toContain('- edit_file: Make precise file edits')
  expect(system).toContain('- write_file: Create or overwrite a file')
})

test('a group session narrowed to read_file is not told it can edit files or run commands', async () => {
  let receive!: (message: IncomingMessage) => void | Promise<void>
  const channel: ChannelDefinition = {
    name: 'fixture',
    description: 'Narrow group fixture',
    start() {},
    stop() {},
    async send() {},
    onMessage(handler) {
      receive = handler
    },
    sessionOptions: () => ({ tools: ['read_file'] }),
  }
  const t = createTestVela({
    responses: [fauxText('ok')],
    extensions: [
      function fixture(api) {
        api.registerChannel(channel)
      },
    ],
  })
  await t.vela.startChannels()
  await receive({
    channelId: 'group',
    chatKind: 'group',
    senderId: 'alice',
    senderName: 'Alice',
    text: 'Hello group',
    replyToId: 'trigger',
  })
  const system = t.model.calls[0]!.system
  expect(system).not.toContain('editing files')
  expect(system).not.toContain('running commands')
  expect(toolsSection(system)).toBe(
    '<tools>\n- read_file: Read file contents (text, or an image by path)\n',
  )
})

test('the default tools carry their own rules, and hiding one drops its rule', async () => {
  const t = createTestVela({
    responses: [fauxText('one')],
  })
  await t.run('hello')
  const withDefaults = t.model.calls[0]!.system
  expect(withDefaults).toContain('- edit_file:')
  expect(withDefaults).toContain('- tool_search:')
  expect(withDefaults).toContain('- Read a file before you change it.')
  expect(withDefaults).toContain('- Use read_file instead of `cat` or `sed`')

  const other = createTestVela({
    session: { tools: ['-edit_file'] },
    responses: [fauxText('ok')],
  })
  await other.run('hello')
  const withoutEdit = other.model.calls[0]!.system
  expect(toolsSection(withoutEdit)).not.toContain('edit_file')
  expect(withoutEdit).not.toContain('Read a file before you change it.')
  // write_file keeps its own rule
  expect(withoutEdit).toContain('- write_file:')
})

test('deferred tools are named only while tool_search can load them', async () => {
  const deferred: VelaExtension = (api) => {
    api.registerTool({
      name: 'later_tool',
      description: 'A deferred tool',
      inputSchema: z.object({}),
      exposure: 'deferred',
      execute: async () => 'later',
    })
  }
  const t = createTestVela({
    extensions: [deferred],
    responses: [fauxText('ok')],
  })
  await t.run('what can you do')
  const system = t.model.calls[0]!.system
  expect(system).toContain('<deferred_tools>')
  expect(system).toContain('later_tool')
  expect(toolsSection(system)).toContain('- tool_search:')

  const hidden = createTestVela({
    extensions: [deferred],
    session: { tools: ['-tool_search'] },
    responses: [fauxText('ok')],
  })
  await hidden.run('what can you do')
  expect(hidden.model.calls[0]!.system).not.toContain('<deferred_tools>')
})

test('systemPrompt replaces the intro, tools, rules and docs and keeps the other sections', async () => {
  const t = createTestVela({ files: { 'AGENTS.md': 'Always use bun.' } })
  const vela = createVela({
    model: t.model,
    cwd: t.cwd,
    systemPrompt: 'You are Exact.',
    appendSystemPrompt: 'Answer in French.',
  })
  try {
    const session = vela.session()
    const system = session.buildSystem()
    expect(system.startsWith('You are Exact.\n\n<addendum>')).toBe(true)
    for (const tag of ['<tools>', '<rules>', '<docs>'])
      expect(system).not.toContain(tag)
    expect(system).toContain('<addendum>\nAnswer in French.\n</addendum>')
    expect(system).toContain('<project_context>')
    expect(system).toContain('<cwd>')
    expect(system).toContain('<env>')
    // A per-turn replacement from a handler is the whole prompt for that turn
    expect(
      session.promptContext(undefined).systemPromptOverride,
    ).toBeUndefined()
  } finally {
    await vela.dispose()
  }
})

test('a before_agent_start handler reads the current prompt and can replace it for one turn', async () => {
  let seen: string | undefined
  let turns = 0
  const replace: VelaExtension = (api) => {
    api.on('before_agent_start', (event) => {
      seen = event.systemPrompt
      // A section an earlier handler wrote is already in the prompt the next handler sees
      event.sections.probe = 'probe text'
      // Only the first turn is replaced
      if (turns++ === 0) return { systemPrompt: `Custom for: ${event.prompt}` }
    })
  }
  let second: string | undefined
  const later: VelaExtension = (api) => {
    api.on('before_agent_start', (event) => {
      second = event.systemPrompt
    })
  }
  const t = createTestVela({
    extensions: [replace, later],
    responses: [fauxText('first'), fauxText('second')],
  })
  await t.run('go')
  expect(seen).toContain('<tools>')
  expect(seen).toContain('<rules>')
  // The next handler sees the replacement an earlier one returned
  expect(second).toBe('Custom for: go')
  expect(t.model.calls[0]!.system).toBe('Custom for: go')

  // The next turn has no replacement of its own: the built prompt comes back, with its section
  await t.run('again')
  const built = t.model.calls[1]!.system
  expect(built).toContain('<tools>')
  expect(built).not.toBe('Custom for: again')
  expect(built).toContain('<probe>\nprobe text\n</probe>')
  expect(second).toBe(built)
})

test('an extension section named like a built-in one does not replace it', async () => {
  const collide: VelaExtension = (api) => {
    api.on('before_agent_start', (event) => {
      event.sections.rules = 'Use the project conventions.'
    })
  }
  const t = createTestVela({
    extensions: [collide],
    responses: [fauxText('ok')],
  })
  await t.run('go')
  const system = t.model.calls[0]!.system
  // The built-in rules stay: the tool guideline and the standing rules
  expect(system).toContain('- Read a file before you change it.')
  expect(system).toContain('- Use tools to check facts')
  // The extension's section is added after them, under its own tag
  expect(system).toContain('<rules>\nUse the project conventions.\n</rules>')
  expect(system.match(/<rules>/g)).toHaveLength(2)
})

test('a preview rebuilds the prompt instead of inheriting the last forced one', async () => {
  const marker = 'APPEND_MARKER'
  const append: VelaExtension = (api) => {
    api.on('before_agent_start', (event) => ({
      systemPrompt: `${event.systemPrompt}\n${marker}`,
    }))
  }
  const t = createTestVela({
    extensions: [append],
    responses: [fauxText('one'), fauxText('two')],
  })
  await t.run('first')
  const preview = await inspectSession(t.vela, t.session, {
    previewExtensions: true,
  })
  await t.run('second')
  const second = t.model.calls[1]!.system
  // The preview is what the next request carries: the marker once, not once per turn
  expect(second.split(marker)).toHaveLength(2)
  expect(preview.systemPrompt).toBe(second)
})

test('inspectSession returns the exact prompt the next request carries', async () => {
  const t = createTestVela({
    files: { 'AGENTS.md': 'Always use bun.' },
    responses: [fauxText('ok')],
  })
  await t.run('hello')
  const inspection = await inspectSession(t.vela, t.session, {
    previewExtensions: true,
  })
  expect(inspection.systemPrompt).toBe(t.model.calls[0]!.system)
  expect(inspection.systemPromptChars).toBe(inspection.systemPrompt.length)
})

test('<docs> points at the folders that exist and stays off without them', async () => {
  const dir = tempDir()
  try {
    const docs = join(dir.path, 'docs')
    mkdirSync(docs)
    writeFileSync(join(docs, 'extensions.md'), '# Extensions')
    writeFileSync(join(dir.path, 'README.md'), '# Vela')
    const t = createTestVela()
    const withDocs = createVela({
      model: t.model,
      cwd: t.cwd,
      docs: {
        docs,
        readme: join(dir.path, 'README.md'),
        examples: join(dir.path, 'missing-examples'),
      },
    })
    try {
      const system = withDocs.session().buildSystem()
      expect(system).toContain('<docs>')
      expect(system).toContain(
        `- Main documentation: ${join(dir.path, 'README.md')}`,
      )
      expect(system).toContain(`- Additional docs: ${docs}`)
      expect(system).not.toContain('Examples:')
      expect(system).toContain('not the current working directory')
    } finally {
      await withDocs.dispose()
    }

    const without = createVela({
      model: t.model,
      cwd: t.cwd,
      docs: { docs: join(dir.path, 'missing-docs') },
    })
    try {
      expect(without.session().buildSystem()).not.toContain('<docs>')
    } finally {
      await without.dispose()
    }
  } finally {
    dir.cleanup()
  }
})

test('extension sections are tagged, so a channel session can read its own section', async () => {
  const section: VelaExtension = (api) => {
    api.on('before_agent_start', (event) => {
      event.sections.memory = 'How to use memory'
    })
  }
  const t = createTestVela({
    extensions: [section],
    responses: [fauxToolCall('read_file', { path: 'a.txt' }), fauxText('ok')],
    files: { 'a.txt': 'content' },
  })
  await t.run('hello')
  const system = t.model.calls[0]!.system
  expect(system).toContain('<memory>\nHow to use memory\n</memory>')
  expect(system.indexOf('<memory>')).toBeGreaterThan(system.indexOf('<env>'))
})

test('a branch checkout keeps the system prompt and arrives as a message instead', async () => {
  const t = createTestVela({
    faux: { cache: true },
    responses: [fauxText('one'), fauxText('two'), fauxText('three')],
  })
  const checkout = (branch: string) => {
    mkdirSync(join(t.cwd, '.git'), { recursive: true })
    writeFileSync(join(t.cwd, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`)
  }
  const promptText = (call: (typeof t.model.calls)[number]) =>
    call.prompt
      .map((message) =>
        typeof message.content === 'string'
          ? message.content
          : message.content
              .map((part) => (part.type === 'text' ? part.text : ''))
              .join(''),
      )
      .join('\n')

  checkout('main')
  await t.run('one')
  // Something else checks out a branch in this session's working tree, as a topic session does
  checkout('vela/442-prompt-cache')
  await t.run('two')
  await t.run('three')

  const calls = t.model.calls
  expect(calls[0]!.system).not.toContain('git branch')
  // The system prompt is the request's cached prefix: a checkout must not rewrite it
  expect(calls[1]!.system).toBe(calls[0]!.system)
  expect(calls[2]!.system).toBe(calls[0]!.system)

  // A stable branch says nothing; a checkout reaches the model as one message
  expect(promptText(calls[0]!)).not.toContain('Git branch')
  expect(promptText(calls[1]!)).toContain('Git branch: vela/442-prompt-cache')
  // An unchanged branch sends nothing new
  expect(
    promptText(calls[2]!).match(/Git branch: vela\/442-prompt-cache/g),
  ).toHaveLength(1)

  // The second request reads the first one's prefix instead of paying for it again
  const usage = t.eventsOf('usage').map((event) => event.usage)
  expect(usage[1]!.cacheReadTokens).toBeGreaterThanOrEqual(
    usage[0]!.cacheWriteTokens - 1,
  )
})
